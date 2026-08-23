/**
 * GET|POST /api/cron/rollover
 *
 * Closes hours whose bidding period has elapsed, opens payment windows, expires
 * windows that ran out, and promotes the next bidder.
 *
 * This endpoint decides who owns the homepage and who gets charged, so it is
 * authenticated with a dedicated shared secret rather than left open. Vercel
 * Cron sends `Authorization: Bearer $CRON_SECRET`; the comparison is constant
 * time so the secret cannot be recovered a byte at a time.
 *
 * The job is idempotent (see runRollover), so a retry, an overlapping run, or a
 * missed window all converge to the same state.
 */
import type { ApiRequest, ApiResponse } from '../../lib/http.ts';
import { requireMethod, sendJson, unauthorized, withErrorHandling } from '../../lib/http.ts';
import { safeEqual } from '../../lib/crypto.ts';
import { env } from '../../lib/env.ts';
import { runRollover } from '../../lib/auction.ts';
import { pruneRateLimits } from '../../lib/ratelimit.ts';
import { audit } from '../../lib/audit.ts';

function authorize(req: ApiRequest): void {
  const header = req.headers.authorization;
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string' || !value.startsWith('Bearer ')) throw unauthorized('Missing cron credentials.');
  if (!safeEqual(value.slice('Bearer '.length), env.cronSecret)) throw unauthorized('Bad cron credentials.');
}

export default withErrorHandling(async function handler(req: ApiRequest, res: ApiResponse) {
  requireMethod(req, 'GET', 'POST');
  authorize(req);

  const report = await runRollover();
  const pruned = await pruneRateLimits();

  // Only record a run that actually changed something, so the audit log stays
  // readable instead of filling with one no-op row per minute.
  if (report.unsold.length || report.released.length) {
    await audit({ action: 'hour.rolled', data: { ...report } });
  }

  sendJson(res, 200, { ok: true, ...report, prunedRateLimits: pruned });
});
