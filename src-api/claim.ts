/**
 * POST /api/claim  { amount, name, message, link, logo?, email? }
 *
 * Buy a slot for whatever you want to pay, and get back a Polar checkout URL.
 *
 * No hour is named here. Everyone who pays airs eventually; the paid pool is
 * ranked by amount, so paying more only moves you sooner, never decides whether
 * you get on at all. Because nobody is ever left with nothing, no buyer has to
 * be told to act, which is what keeps this flow free of outbound email.
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
  validateBidDollars,
} from '../lib/validate.ts';
import { purchase, releaseClaim } from '../lib/auction.ts';
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

  const amountCents = validateBidDollars(body.amount);

  const displayName = validateDisplayName(body.name);
  const tagline = validateTagline(body.message);
  const linkUrl = validateLinkUrl(body.link);
  const logoDataUrl = validateLogo(body.logo) ?? (await fetchLogoForLink(linkUrl));

  // Records the purchase and opens a pending payment. No hour is taken yet.
  const claim = await purchase({
    amountCents,
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
      amountCents: claim.amountCents,
      email: buyer.email,
      bidId: claim.bidId,
      paymentId: claim.paymentId,
    });
  } catch (error) {
    await releaseClaim(claim.bidId);
    await audit({
      action: 'claim.released',
      actorId: buyer.id,
      subject: `bid:${claim.bidId}`,
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
    subject: `bid:${claim.bidId}`,
    ipHash,
    data: { bidId: claim.bidId, amountCents: claim.amountCents },
  });

  sendJson(res, 201, {
    ok: true,
    amountCents: claim.amountCents,
    checkoutUrl: checkout.url,
    listing: { name: displayName, tagline, link: linkUrl, logo: logoDataUrl },
  });
});
