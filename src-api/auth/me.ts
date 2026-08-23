/**
 * GET /api/auth/me
 *
 * Reports whether the caller is signed in, and hands the page its CSRF token.
 *
 * The token is delivered in the response body rather than a readable cookie:
 * a cross-origin page can cause the browser to send our cookies, but it cannot
 * read this response, so it never learns the value it would need to forge a
 * state-changing request.
 */
import type { ApiRequest, ApiResponse } from '../../lib/http.ts';
import { requireMethod, sendJson, withErrorHandling } from '../../lib/http.ts';
import { csrfTokenFor, getSession } from '../../lib/session.ts';

export default withErrorHandling(async function handler(req: ApiRequest, res: ApiResponse) {
  requireMethod(req, 'GET');

  const session = await getSession(req);
  if (!session) {
    sendJson(res, 200, { signedIn: false });
    return;
  }

  sendJson(res, 200, {
    signedIn: true,
    email: session.email,
    csrfToken: csrfTokenFor(session.id),
  });
});
