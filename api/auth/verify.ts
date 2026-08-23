/**
 * GET /api/auth/verify?token=...
 *
 * Consumes a sign-in link and starts a session.
 *
 * Notes on the shape of this endpoint:
 *
 *  - It is a GET with side effects, which is unavoidable for an emailed link.
 *    The mitigations are that the token is single-use, short-lived, and high
 *    entropy, so a link that leaks (browser history, a forwarded email) is
 *    already spent.
 *
 *  - The redirect target is a constant. Accepting a `next` parameter here is
 *    the standard way magic-link endpoints become open redirects, and an open
 *    redirect on the login path is a credible phishing primitive.
 *
 *  - The token is consumed with a conditional UPDATE, so two simultaneous
 *    clicks cannot both mint a session.
 */
import type { ApiRequest, ApiResponse } from '../../lib/http.ts';
import { applySecurityHeaders, clientIp, requireMethod, withErrorHandling } from '../../lib/http.ts';
import { hashIp, hashToken } from '../../lib/crypto.ts';
import { query } from '../../lib/db.ts';
import { createSession, setSessionCookie } from '../../lib/session.ts';
import { consume } from '../../lib/ratelimit.ts';
import { audit } from '../../lib/audit.ts';
import { env } from '../../lib/env.ts';

function redirect(res: ApiResponse, path: string): void {
  applySecurityHeaders(res);
  res.statusCode = 303;
  res.setHeader('Location', `${env.siteOrigin}${path}`);
  res.end();
}

export default withErrorHandling(async function handler(req: ApiRequest, res: ApiResponse) {
  requireMethod(req, 'GET');

  const ip = clientIp(req);
  // Throttle guessing. The token space is 256 bits, so this is belt and braces.
  const attempt = await consume('login:verify', ip ?? 'unknown', 30, 3600);
  if (!attempt.allowed) {
    redirect(res, '/?signin=throttled');
    return;
  }

  const url = new URL(req.url ?? '/', env.siteOrigin);
  const token = url.searchParams.get('token');
  if (!token || token.length < 20 || token.length > 128) {
    redirect(res, '/?signin=invalid');
    return;
  }

  // Single atomic consume-and-return: the WHERE clause is the race guard.
  const { rows } = await query<{ user_id: string }>(
    `UPDATE login_tokens
        SET consumed_at = now()
      WHERE token_hash = $1
        AND consumed_at IS NULL
        AND expires_at > now()
      RETURNING user_id`,
    [hashToken(token)],
  );
  const consumed = rows[0];
  if (!consumed) {
    await audit({ action: 'login.failed', ipHash: hashIp(ip), data: { reason: 'bad_or_used_token' } });
    redirect(res, '/?signin=expired');
    return;
  }

  // Re-check the account state at the moment of use, not at the moment of send.
  const { rows: userRows } = await query<{ id: string }>(
    `SELECT id FROM users WHERE id = $1 AND disabled_at IS NULL`,
    [consumed.user_id],
  );
  if (!userRows[0]) {
    redirect(res, '/?signin=invalid');
    return;
  }

  const userAgent = req.headers['user-agent'];
  const session = await createSession(
    consumed.user_id,
    ip,
    Array.isArray(userAgent) ? (userAgent[0] ?? null) : (userAgent ?? null),
  );
  setSessionCookie(res, session.token, session.expiresAt);

  await query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [consumed.user_id]);
  await audit({ action: 'login.verified', actorId: consumed.user_id, ipHash: hashIp(ip) });

  redirect(res, '/?signin=ok');
});
