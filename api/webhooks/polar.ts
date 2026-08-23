/**
 * POST /api/webhooks/polar
 *
 * The only code path in this system that may declare an hour paid.
 *
 * Trust boundary notes:
 *
 *  - Body parsing is disabled below so we can hash the exact bytes Polar
 *    signed. Re-serialising parsed JSON changes whitespace and key order, and
 *    the signature would never match. If the raw body cannot be read, the
 *    request is rejected rather than processed unverified -- fail closed.
 *
 *  - Replay is blocked by inserting the delivery id into `webhook_events`
 *    under a primary key. The database, not application logic, decides whether
 *    an event is a duplicate, so two concurrent deliveries cannot both proceed.
 *
 *  - We resolve our own payment id from the event's metadata, then act only on
 *    that row. Amounts in the event are not used to compute anything; the
 *    authoritative amount was fixed when the bid was accepted.
 *
 *  - Verification failures return 400 with no detail. A precise error would
 *    help someone probe the signature check.
 */
import type { ApiRequest, ApiResponse } from '../../lib/http.ts';
import { readRawBody, requireMethod, sendJson, withErrorHandling } from '../../lib/http.ts';
import { verifyWebhook } from '../../lib/polar.ts';
import { findPaymentByCheckout, markPaid, markRefunded } from '../../lib/auction.ts';
import { query } from '../../lib/db.ts';
import { audit } from '../../lib/audit.ts';
import { validateUuid } from '../../lib/validate.ts';

/** Required: hand us the unparsed body so the signature can be checked. */
export const config = { api: { bodyParser: false } };

/** Pull our payment id out of the event, preferring metadata we set ourselves. */
async function resolvePaymentId(data: Record<string, unknown>): Promise<string | null> {
  const metadata = (data.metadata ?? {}) as Record<string, unknown>;
  const fromMetadata = metadata.payment_id;
  if (typeof fromMetadata === 'string') {
    try {
      return validateUuid(fromMetadata, 'payment_id');
    } catch {
      return null; // malformed metadata is not a lookup key
    }
  }

  // Fall back to the checkout id, which we stored when creating the session.
  const checkoutId = data.checkout_id ?? (data.checkout as Record<string, unknown> | undefined)?.id ?? data.id;
  if (typeof checkoutId === 'string' && checkoutId.length > 0 && checkoutId.length < 200) {
    const payment = await findPaymentByCheckout(checkoutId);
    return payment?.id ?? null;
  }
  return null;
}

export default withErrorHandling(async function handler(req: ApiRequest, res: ApiResponse) {
  requireMethod(req, 'POST');

  const raw = await readRawBody(req);
  if (raw.length === 0) {
    sendJson(res, 400, { error: 'invalid' });
    return;
  }

  let event;
  try {
    event = verifyWebhook(raw, req.headers);
  } catch (error) {
    // Log the reason for ourselves; tell the caller nothing.
    console.warn('webhook rejected', { message: (error as Error).message });
    await audit({ action: 'webhook.rejected', data: { reason: 'signature' } });
    sendJson(res, 400, { error: 'invalid' });
    return;
  }

  // Idempotency gate. A conflict means we have seen this delivery already.
  const { rowCount } = await query(
    `INSERT INTO webhook_events (provider, event_id, event_type)
     VALUES ('polar', $1, $2)
     ON CONFLICT (provider, event_id) DO NOTHING`,
    [event.id, event.type],
  );
  if (rowCount === 0) {
    // Acknowledge so the provider stops retrying, but do no work.
    sendJson(res, 200, { ok: true, duplicate: true });
    return;
  }

  await audit({ action: 'webhook.received', subject: event.id, data: { type: event.type } });

  const paymentId = await resolvePaymentId(event.data);

  switch (event.type) {
    case 'order.paid':
    case 'checkout.updated': {
      // `checkout.updated` fires for several statuses; only a succeeded one counts.
      if (event.type === 'checkout.updated' && event.data.status !== 'succeeded') break;
      if (!paymentId) {
        console.warn('paid event with no resolvable payment', { eventId: event.id });
        break;
      }
      const orderId = typeof event.data.id === 'string' ? event.data.id : null;
      await markPaid(paymentId, orderId);
      break;
    }
    case 'order.refunded': {
      if (paymentId) await markRefunded(paymentId);
      break;
    }
    default:
      // Unhandled event types are recorded and acknowledged, not an error.
      break;
  }

  // Always 200 on a verified event, so the provider does not retry work we have
  // already recorded as seen.
  sendJson(res, 200, { ok: true });
});
