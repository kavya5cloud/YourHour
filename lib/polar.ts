/**
 * Polar payments: creating a checkout, and verifying inbound webhooks.
 *
 * The security rule for this file: the client is never a source of truth about
 * payment. A browser returning to the success URL proves nothing -- anyone can
 * navigate to it. An hour is only ever marked paid by `verifyWebhook` accepting
 * a signed event from Polar.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from './env.ts';

export interface CheckoutSession {
  id: string;
  url: string;
}

/**
 * Create a hosted checkout for a winning bid.
 *
 * `metadata` carries our own ids back to us on the webhook so we never have to
 * guess which bid an event refers to.
 */
export async function createCheckout(options: {
  amountCents: number;
  email: string;
  bidId: string;
  paymentId: string;
}): Promise<CheckoutSession> {
  const response = await fetch(`${env.polar.apiBase}/v1/checkouts/`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.polar.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      product_id: env.polar.productId,
      amount: options.amountCents,
      customer_email: options.email,
      success_url: `${env.siteOrigin}/?paid=1`,
      metadata: {
        bid_id: options.bidId,
        payment_id: options.paymentId,
      },
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    console.error('polar checkout creation failed', { status: response.status });
    throw new Error('Could not create checkout session');
  }

  const data = (await response.json()) as { id?: unknown; url?: unknown };
  if (typeof data.id !== 'string' || typeof data.url !== 'string') {
    throw new Error('Malformed checkout response from Polar');
  }
  // Never hand out a redirect target we have not confirmed is https.
  const url = new URL(data.url);
  if (url.protocol !== 'https:') throw new Error('Checkout URL was not https');

  return { id: data.id, url: url.toString() };
}

/** Events we act on. Anything else is acknowledged and ignored. */
export type PolarEventType = 'order.paid' | 'order.refunded' | 'checkout.updated' | string;

export interface PolarEvent {
  id: string;
  type: PolarEventType;
  data: Record<string, unknown>;
}

const SIGNATURE_TOLERANCE_SECONDS = 300;

/**
 * Verify a webhook against the Standard Webhooks scheme that Polar uses.
 *
 * Checks performed, all of which must pass:
 *  1. The three signature headers are present.
 *  2. The timestamp is within +/- 5 minutes, which bounds replay of a captured
 *     request to that window.
 *  3. An HMAC-SHA256 over `id.timestamp.body` matches one of the offered
 *     signatures, compared in constant time.
 *
 * The raw request bytes must be passed in unmodified: re-serialising parsed
 * JSON changes key order and whitespace, and the signature would never match.
 */
export function verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): PolarEvent {
  const header = (name: string): string | null => {
    const value = headers[name];
    const single = Array.isArray(value) ? value[0] : value;
    return typeof single === 'string' && single !== '' ? single : null;
  };

  const id = header('webhook-id');
  const timestamp = header('webhook-timestamp');
  const signatureHeader = header('webhook-signature');
  if (!id || !timestamp || !signatureHeader) {
    throw new Error('Missing webhook signature headers');
  }

  const sentAt = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(sentAt)) throw new Error('Invalid webhook timestamp');
  const skew = Math.abs(Math.floor(Date.now() / 1000) - sentAt);
  if (skew > SIGNATURE_TOLERANCE_SECONDS) throw new Error('Webhook timestamp outside tolerance');

  // Secrets are distributed as `whsec_<base64>`; the raw key is the decoded part.
  const secret = env.polar.webhookSecret.startsWith('whsec_')
    ? Buffer.from(env.polar.webhookSecret.slice('whsec_'.length), 'base64')
    : Buffer.from(env.polar.webhookSecret, 'utf8');

  const expected = createHmac('sha256', secret)
    .update(`${id}.${sentAt}.${rawBody.toString('utf8')}`, 'utf8')
    .digest();

  // The header may offer several space-separated versioned signatures during a
  // secret rotation; any one valid v1 entry is enough.
  const candidates = signatureHeader
    .split(' ')
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith('v1,'))
    .map((entry) => Buffer.from(entry.slice(3), 'base64'));

  const matched = candidates.some(
    (candidate) => candidate.length === expected.length && timingSafeEqual(candidate, expected),
  );
  if (!matched) throw new Error('Webhook signature mismatch');

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw new Error('Webhook body is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) throw new Error('Webhook body is not an object');

  const event = parsed as { type?: unknown; data?: unknown };
  if (typeof event.type !== 'string') throw new Error('Webhook event has no type');

  return {
    // `webhook-id` is the delivery identifier used for idempotency.
    id,
    type: event.type,
    data: (typeof event.data === 'object' && event.data !== null ? event.data : {}) as Record<string, unknown>,
  };
}
