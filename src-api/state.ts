/**
 * GET /api/state
 *
 * The public view of the auction. Unauthenticated and safe to cache for a
 * second or two at the edge.
 *
 * This response is deliberately thin: current owner, standing lead, recent
 * winners, totals. It carries no email addresses, no user ids, no bid ids, and
 * nothing about losing bidders. A public auction feed should not double as a
 * directory of who is bidding what.
 *
 * `serverTime` is included so the page can render a countdown against our clock
 * rather than the visitor's, which may be wrong or deliberately skewed.
 */
import type { ApiRequest, ApiResponse } from '../lib/http.ts';
import { requireMethod, sendJson, withErrorHandling } from '../lib/http.ts';
import { getPublicState } from '../lib/auction.ts';

export default withErrorHandling(async function handler(req: ApiRequest, res: ApiResponse) {
  requireMethod(req, 'GET');

  const state = await getPublicState();

  // Overrides the default `no-store`. This payload is identical for every
  // visitor, so a short shared cache absorbs bursts without showing a stale
  // price for long; `stale-while-revalidate` keeps the page responsive during
  // a refresh. Passed as an override because sendJson re-applies the defaults.
  sendJson(res, 200, state, {
    'Cache-Control': 'public, max-age=1, s-maxage=2, stale-while-revalidate=5',
  });
});
