/**
 * POST /api/bids  { amount, name, message, link, email? }
 *
 * Place a bid on the next hour. Signing in first is NOT required.
 *
 * Why it works this way: an hour rolls over in minutes, so gating bidding
 * behind "check your inbox, click a link, come back" can outlast the thing
 * being bid on. The bid form is therefore the whole signup -- an email address
 * in the body creates or matches an account, and the bid lands immediately.
 *
 * Verification still happens, but at the moment it actually protects money:
 * the winner has to open the emailed checkout link to pay. Owning the inbox is
 * enforced there rather than at the door.
 *
 * What stops abuse in the meantime:
 *   - Unverified accounts are capped at MAX_UNVERIFIED_BID_CENTS, so a
 *     stranger cannot park a huge bid on an hour and never pay. Above the cap
 *     we send a sign-in link and ask them to confirm the address.
 *   - Rate limits per IP and per email, counted in the database.
 *   - Origin checks, so another site cannot drive this endpoint.
 *   - A losing bid costs nothing; a winning one must clear checkout in five
 *     minutes or the hour passes to the next bidder.
 */
import type { ApiRequest, ApiResponse } from '../lib/http.ts';
import {
  clientIp,
  readJsonBody,
  requireMethod,
  requireSameOrigin,
  sendJson,
  withErrorHandling,
  conflict,
} from '../lib/http.ts';
import { getSession, requireCsrf } from '../lib/session.ts';
import { enforce } from '../lib/ratelimit.ts';
import { hashIp, hashToken, randomToken } from '../lib/crypto.ts';
import { env } from '../lib/env.ts';
import {
  validateBidDollars,
  validateDisplayName,
  validateEmail,
  validateLinkUrl,
  validateTagline,
  formatMoney,
} from '../lib/validate.ts';
import { assertBiddingWindowOpen, placeBid } from '../lib/auction.ts';
import { audit } from '../lib/audit.ts';
import { query } from '../lib/db.ts';
import { sendOutbidNotice, sendLoginLink } from '../lib/mailer.ts';

interface Bidder {
  id: string;
  email: string;
  verified: boolean;
}

/**
 * Resolve who is bidding.
 *
 * A live session wins, because it is already proof of the address. Otherwise
 * the submitted email creates or matches an account. Either way we never take
 * the caller's word for anything except the address itself.
 */
async function resolveBidder(req: ApiRequest, body: Record<string, unknown>): Promise<Bidder> {
  const session = await getSession(req);
  if (session) {
    // A cookie-authenticated request carries ambient authority, so it must
    // still prove it came from our page.
    requireCsrf(req, session);
    const { rows } = await query<{ email_verified_at: Date | null }>(
      `SELECT email_verified_at FROM users WHERE id = $1`,
      [session.userId],
    );
    return {
      id: session.userId,
      email: session.email,
      verified: rows[0]?.email_verified_at !== null && rows[0]?.email_verified_at !== undefined,
    };
  }

  const email = validateEmail(body.email);
  const { rows } = await query<{ id: string; disabled_at: Date | null; email_verified_at: Date | null }>(
    `INSERT INTO users (email) VALUES ($1)
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
     RETURNING id, disabled_at, email_verified_at`,
    [email],
  );
  const user = rows[0]!;
  if (user.disabled_at !== null) {
    // Same message an ordinary rejection gives; no hint the account is blocked.
    throw conflict('That bid could not be accepted.', 'bid_rejected');
  }
  return { id: user.id, email, verified: user.email_verified_at !== null };
}

/** Send a fresh sign-in link so a capped bidder can raise their ceiling. */
async function sendVerification(userId: string, email: string, ip: string | null): Promise<void> {
  const allowed = await enforce(
    'login:email',
    email,
    env.limits.loginLinksPerEmail,
    3600,
    'Too many emails requested. Try again shortly.',
  ).then(
    () => true,
    () => false,
  );
  if (!allowed) return;

  await query(
    `UPDATE login_tokens SET consumed_at = now()
      WHERE user_id = $1 AND consumed_at IS NULL AND expires_at > now()`,
    [userId],
  );
  const token = randomToken(32);
  await query(
    `INSERT INTO login_tokens (user_id, token_hash, expires_at, request_ip_hash)
     VALUES ($1, $2, now() + interval '15 minutes', $3)`,
    [userId, hashToken(token), hashIp(ip)],
  );
  await sendLoginLink(email, `${env.siteOrigin}/api/auth/verify?token=${encodeURIComponent(token)}`).catch((error) =>
    console.error('verification email failed', { message: (error as Error).message }),
  );
}

export default withErrorHandling(async function handler(req: ApiRequest, res: ApiResponse) {
  requireMethod(req, 'POST');
  requireSameOrigin(req);

  const ip = clientIp(req);
  const ipHash = hashIp(ip);

  // Charged before validation, so a flood of malformed bodies still costs quota.
  await enforce('bid:ip', ip, env.limits.bidsPerIpPerHour, 3600, 'Too many bids from this connection.');

  assertBiddingWindowOpen();

  const body = await readJsonBody(req);
  const bidder = await resolveBidder(req, body);

  await enforce('bid:user', bidder.id, env.limits.bidsPerUserPerHour, 3600, 'You are bidding too quickly.');

  const amountCents = validateBidDollars(body.amount);
  const displayName = validateDisplayName(body.name);
  const tagline = validateTagline(body.message);
  const linkUrl = validateLinkUrl(body.link);

  // The unverified ceiling. Checked after validation so the message can name a
  // real number, and before placeBid so nothing is written.
  if (!bidder.verified && amountCents > env.auction.maxUnverifiedBidCents) {
    await sendVerification(bidder.id, bidder.email, ip);
    await audit({
      action: 'bid.rejected',
      actorId: bidder.id,
      ipHash,
      data: { reason: 'unverified_over_cap', amountCents },
    });
    sendJson(res, 403, {
      error: 'verification_required',
      message:
        `Bids over ${formatMoney(env.auction.maxUnverifiedBidCents)} need a confirmed email. ` +
        `We just sent a link to ${bidder.email} -- open it, then bid again.`,
      maxUnverifiedCents: env.auction.maxUnverifiedBidCents,
    });
    return;
  }

  const result = await placeBid({
    userId: bidder.id,
    amountCents,
    displayName,
    tagline,
    linkUrl,
    ipHash,
  });

  await audit({
    action: 'bid.placed',
    actorId: bidder.id,
    subject: `hour:${result.hourId}`,
    ipHash,
    data: { bidId: result.bidId, amountCents, verified: bidder.verified },
  });

  if (result.previousLeaderUserId) {
    void notifyOutbid(result.previousLeaderUserId, result.hourId, amountCents);
  }

  sendJson(res, 201, {
    ok: true,
    hour: result.hourId,
    amountCents: result.amountCents,
    verified: bidder.verified,
    // Echo the stored values so the page shows what was actually saved after
    // normalisation, not the raw text that was typed.
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
