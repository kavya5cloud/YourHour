/**
 * POST /api/auth/request-link  { email }
 *
 * Sends a single-use sign-in link.
 *
 * Two properties this endpoint holds:
 *
 *  - No account enumeration. The response is identical whether or not the
 *    address has an account, whether or not delivery succeeded, and whether or
 *    not the caller hit the per-email limit. An attacker cannot use it to test
 *    which addresses are registered.
 *
 *  - No open relay. It is rate limited per email and per IP, because an
 *    unthrottled "send mail to an address of your choosing" endpoint is a
 *    spam cannon that will burn the sending domain's reputation.
 */
import type { ApiRequest, ApiResponse } from '../../lib/http.ts';
import { readJsonBody, requireMethod, requireSameOrigin, sendJson, withErrorHandling, clientIp } from '../../lib/http.ts';
import { validateEmail } from '../../lib/validate.ts';
import { query } from '../../lib/db.ts';
import { hashIp, hashToken, randomToken } from '../../lib/crypto.ts';
import { consume } from '../../lib/ratelimit.ts';
import { sendLoginLink } from '../../lib/mailer.ts';
import { audit } from '../../lib/audit.ts';
import { env } from '../../lib/env.ts';

const TOKEN_TTL_MINUTES = 15;

/** Identical response on every path, so nothing leaks through the reply. */
const GENERIC_OK = {
  ok: true,
  message: 'If that address can bid, a sign-in link is on its way.',
};

export default withErrorHandling(async function handler(req: ApiRequest, res: ApiResponse) {
  requireMethod(req, 'POST');
  requireSameOrigin(req);

  const ip = clientIp(req);
  const body = await readJsonBody(req);
  const email = validateEmail(body.email);

  // Both limiters are consumed, but a rejection is reported as success so the
  // caller cannot distinguish "throttled" from "sent".
  const [byEmail, byIp] = await Promise.all([
    consume('login:email', email, env.limits.loginLinksPerEmail, 3600),
    consume('login:ip', ip ?? 'unknown', env.limits.loginLinksPerIp, 3600),
  ]);

  if (!byEmail.allowed || !byIp.allowed) {
    await audit({ action: 'login.failed', ipHash: hashIp(ip), data: { reason: 'rate_limited' } });
    sendJson(res, 200, GENERIC_OK);
    return;
  }

  // Upsert the account. Signing in for the first time is also signing up.
  const { rows } = await query<{ id: string; disabled_at: Date | null }>(
    `INSERT INTO users (email) VALUES ($1)
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
     RETURNING id, disabled_at`,
    [email],
  );
  const user = rows[0]!;

  // A disabled account gets the same reply and no email.
  if (user.disabled_at !== null) {
    await audit({ action: 'login.failed', actorId: user.id, ipHash: hashIp(ip), data: { reason: 'disabled' } });
    sendJson(res, 200, GENERIC_OK);
    return;
  }

  // Invalidate outstanding links so only the newest one works.
  await query(
    `UPDATE login_tokens SET consumed_at = now()
      WHERE user_id = $1 AND consumed_at IS NULL AND expires_at > now()`,
    [user.id],
  );

  const token = randomToken(32);
  await query(
    `INSERT INTO login_tokens (user_id, token_hash, expires_at, request_ip_hash)
     VALUES ($1, $2, now() + ($3 || ' minutes')::interval, $4)`,
    [user.id, hashToken(token), String(TOKEN_TTL_MINUTES), hashIp(ip)],
  );

  const url = `${env.siteOrigin}/api/auth/verify?token=${encodeURIComponent(token)}`;
  try {
    await sendLoginLink(email, url);
  } catch (error) {
    // Delivery failure is logged, not surfaced -- the reply must not vary.
    console.error('login link delivery failed', { message: (error as Error).message });
  }

  await audit({ action: 'login.requested', actorId: user.id, ipHash: hashIp(ip) });
  sendJson(res, 200, GENERIC_OK);
});
