/**
 * POST /api/claim  { hourId, name, message, link, logo?, email? }
 *
 * Buy one specific hour outright and get back a Polar checkout URL.
 *
 * This replaces bidding. The price of an hour is a function of how soon it is
 * (`priceForHour`), so paying more buys a sooner slot without anyone being
 * displaced -- which is what lets this flow work with no outbound email at all.
 * The buyer learns their hour at the moment they pay, on Polar's own
 * confirmation page, so nothing ever has to be sent to them afterwards.
 *
 * No email is required to reach checkout: Polar collects one itself. An address
 * is still accepted and stored when offered, because it is what lets a buyer
 * come back and be recognised.
 *
 * Nothing here marks an hour paid. Only the Polar webhook may do that.
 */
import type { ApiRequest, ApiResponse } from '../lib/http.ts';
import {
  clientIp,
  readJsonBody,
  requireMethod,
  requireSameOrigin,
  sendJson,
  withErrorHandling,
  badRequest,
} from '../lib/http.ts';
import { getSession } from '../lib/session.ts';
import { enforce } from '../lib/ratelimit.ts';
import { hashIp } from '../lib/crypto.ts';
import { env } from '../lib/env.ts';
import {
  validateDisplayName,
  validateEmail,
  validateLinkUrl,
  validateLogo,
  validateTagline,
} from '../lib/validate.ts';
import { claimHour, releaseClaim } from '../lib/auction.ts';
import { fetchLogoForLink } from '../lib/logo.ts';
import { createCheckout } from '../lib/polar.ts';
import { audit } from '../lib/audit.ts';
import { query } from '../lib/db.ts';

/** The buyer: an existing session if there is one, otherwise the address given. */
async function resolveBuyer(
  req: ApiRequest,
  body: Record<string, unknown>,
): Promise<{ id: string; email: string }> {
  const session = await getSession(req);
  if (session) return { id: session.userId, email: session.email };

  const email = validateEmail(body.email);
  const { rows } = await query<{ id: string; disabled_at: Date | null }>(
    `INSERT INTO users (email) VALUES ($1)
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
     RETURNING id, disabled_at`,
    [email],
  );
  const user = rows[0]!;
  if (user.disabled_at !== null) throw badRequest('That account cannot claim hours.', 'account_disabled');
  return { id: user.id, email };
}

export default withErrorHandling(async function handler(req: ApiRequest, res: ApiResponse) {
  requireMethod(req, 'POST');
  requireSameOrigin(req);

  const ip = clientIp(req);
  const ipHash = hashIp(ip);
  await enforce('claim:ip', ip, env.limits.bidsPerIpPerHour, 3600, 'Too many attempts from this connection.');

  const body = await readJsonBody(req);
  const buyer = await resolveBuyer(req, body);
  await enforce('claim:user', buyer.id, env.limits.bidsPerUserPerHour, 3600, 'You are going too quickly.');

  const hourId = Number(body.hourId);
  if (!Number.isInteger(hourId)) throw badRequest('Pick an hour to claim.', 'hour_required');

  const displayName = validateDisplayName(body.name);
  const tagline = validateTagline(body.message);
  const linkUrl = validateLinkUrl(body.link);
  const logoDataUrl = validateLogo(body.logo) ?? (await fetchLogoForLink(linkUrl));

  // Reserves the hour and opens a pending payment. Throws 409 if it is taken.
  const claim = await claimHour({
    hourId,
    userId: buyer.id,
    displayName,
    tagline,
    linkUrl,
    logoDataUrl,
    ipHash,
  });

  // If Polar cannot open a checkout, put the hour straight back on sale rather
  // than leaving it reserved for a buyer who was never given a way to pay.
  let checkout;
  try {
    checkout = await createCheckout({
      amountCents: claim.priceCents,
      email: buyer.email,
      hourId: claim.hourId,
      bidId: claim.bidId,
      paymentId: claim.paymentId,
    });
  } catch (error) {
    await releaseClaim(claim.bidId);
    await audit({
      action: 'claim.released',
      actorId: buyer.id,
      subject: `hour:${claim.hourId}`,
      data: { reason: 'checkout_failed' },
    });
    throw error;
  }

  await query(`UPDATE payments SET provider_checkout_id = $1 WHERE id = $2`, [
    checkout.id,
    claim.paymentId,
  ]);

  await audit({
    action: 'claim.opened',
    actorId: buyer.id,
    subject: `hour:${claim.hourId}`,
    ipHash,
    data: { bidId: claim.bidId, priceCents: claim.priceCents },
  });

  sendJson(res, 201, {
    ok: true,
    hour: claim.hourId,
    priceCents: claim.priceCents,
    checkoutUrl: checkout.url,
    reservedSeconds: env.auction.reservationSeconds,
    listing: { name: displayName, tagline, link: linkUrl, logo: logoDataUrl },
  });
});
