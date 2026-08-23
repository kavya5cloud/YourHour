/**
 * POST /api/bids  { amount, name, message, link }
 *
 * Place a bid on the next hour.
 *
 * The layered checks, in the order they run and why that order:
 *   1. Method + Origin  -- cheapest rejections first, before any database work.
 *   2. Session          -- anonymous bids are not a thing; a winner must be
 *                          reachable by email to be charged.
 *   3. CSRF             -- proves the request came from our own page.
 *   4. Rate limit       -- per user and per IP, before validation, so a flood of
 *                          malformed bodies still costs the attacker its quota.
 *   5. Validation       -- normalises and bounds every field.
 *   6. placeBid         -- re-checks price and deadline under a row lock.
 *
 * The amount the client believes is winning is never trusted. Step 6 recomputes
 * the required bid from the database inside the lock, so a stale or forged
 * "current price" in the request changes nothing.
 */
import type { ApiRequest, ApiResponse } from '../lib/http.ts';
import { clientIp, readJsonBody, requireMethod, requireSameOrigin, sendJson, withErrorHandling } from '../lib/http.ts';
import { requireCsrf, requireSession } from '../lib/session.ts';
import { enforce } from '../lib/ratelimit.ts';
import { hashIp } from '../lib/crypto.ts';
import { env } from '../lib/env.ts';
import {
  validateBidDollars,
  validateDisplayName,
  validateLinkUrl,
  validateTagline,
  formatMoney,
} from '../lib/validate.ts';
import { assertBiddingWindowOpen, placeBid } from '../lib/auction.ts';
import { audit } from '../lib/audit.ts';
import { query } from '../lib/db.ts';
import { sendOutbidNotice } from '../lib/mailer.ts';

export default withErrorHandling(async function handler(req: ApiRequest, res: ApiResponse) {
  requireMethod(req, 'POST');
  requireSameOrigin(req);

  const session = await requireSession(req);
  requireCsrf(req, session);

  const ip = clientIp(req);
  const ipHash = hashIp(ip);

  await enforce('bid:user', session.userId, env.limits.bidsPerUserPerHour, 3600, 'You are bidding too quickly.');
  await enforce('bid:ip', ip, env.limits.bidsPerIpPerHour, 3600, 'Too many bids from this connection.');

  assertBiddingWindowOpen();

  const body = await readJsonBody(req);
  const amountCents = validateBidDollars(body.amount);
  const displayName = validateDisplayName(body.name);
  const tagline = validateTagline(body.message);
  const linkUrl = validateLinkUrl(body.link);

  const result = await placeBid({
    userId: session.userId,
    amountCents,
    displayName,
    tagline,
    linkUrl,
    ipHash,
  });

  await audit({
    action: 'bid.placed',
    actorId: session.userId,
    subject: `hour:${result.hourId}`,
    ipHash,
    data: { bidId: result.bidId, amountCents },
  });

  // Courtesy notice to whoever just lost the lead. Fire-and-forget: a mail
  // problem must not fail a bid that is already committed.
  if (result.previousLeaderUserId) {
    void notifyOutbid(result.previousLeaderUserId, result.hourId, amountCents);
  }

  sendJson(res, 201, {
    ok: true,
    hour: result.hourId,
    amountCents: result.amountCents,
    // Echo the stored values so the page shows exactly what was saved after
    // normalisation, rather than the raw text that was typed.
    listing: { name: displayName, tagline, link: linkUrl },
    message: `You lead Hour ${result.hourId} at ${formatMoney(result.amountCents)}. No payment was taken.`,
  });
});

async function notifyOutbid(userId: string, hourId: number, amountCents: number): Promise<void> {
  try {
    const { rows } = await query<{ email: string }>(
      `SELECT email FROM users WHERE id = $1 AND disabled_at IS NULL`,
      [userId],
    );
    const email = rows[0]?.email;
    if (email) await sendOutbidNotice(email, hourId, formatMoney(amountCents));
  } catch (error) {
    console.error('outbid notice failed', { message: (error as Error).message });
  }
}
