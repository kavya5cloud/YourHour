/**
 * POST /api/auth/logout
 *
 * Revokes the session server-side and clears the cookie.
 *
 * Revoking the row is the part that matters: clearing the cookie alone would
 * leave a still-valid token in anything that already captured it. It is a POST
 * with CSRF and origin checks so that a third-party page cannot log a user out
 * as a nuisance.
 */
import type { ApiRequest, ApiResponse } from '../../lib/http.ts';
import { clientIp, requireMethod, requireSameOrigin, sendJson, withErrorHandling } from '../../lib/http.ts';
import { clearSessionCookie, getSession, requireCsrf, revokeSession } from '../../lib/session.ts';
import { audit } from '../../lib/audit.ts';
import { hashIp } from '../../lib/crypto.ts';

export default withErrorHandling(async function handler(req: ApiRequest, res: ApiResponse) {
  requireMethod(req, 'POST');
  requireSameOrigin(req);

  const session = await getSession(req);
  if (session) {
    requireCsrf(req, session);
    await revokeSession(session.id);
    await audit({ action: 'logout', actorId: session.userId, ipHash: hashIp(clientIp(req)) });
  }

  // Always clear the cookie, even if no session matched, so a stale or already
  // revoked cookie does not linger in the browser.
  clearSessionCookie(res);
  sendJson(res, 200, { ok: true });
});
