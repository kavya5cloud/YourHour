/**
 * GET  /api/moderation           -- list listings awaiting review
 * POST /api/moderation  { bidId, decision }
 *
 * Human review of the text that goes on the homepage.
 *
 * Authorisation is an explicit allowlist of user ids in MODERATOR_USER_IDS,
 * checked against the authenticated session. There is no self-service path to
 * becoming a moderator and no role column a compromised account could edit --
 * the privilege lives in deployment configuration.
 *
 * Until a listing is approved, `getPublicState` substitutes a neutral
 * placeholder, so an unreviewed bid can win an hour without its text ever
 * being displayed.
 */
import type { ApiRequest, ApiResponse } from '../lib/http.ts';
import {
  badRequest,
  clientIp,
  forbidden,
  readJsonBody,
  requireMethod,
  requireSameOrigin,
  sendJson,
  withErrorHandling,
} from '../lib/http.ts';
import { requireCsrf, requireSession, type Session } from '../lib/session.ts';
import { query } from '../lib/db.ts';
import { env } from '../lib/env.ts';
import { validateUuid } from '../lib/validate.ts';
import { audit } from '../lib/audit.ts';
import { hashIp } from '../lib/crypto.ts';

function requireModerator(session: Session): void {
  if (!env.moderatorIds.includes(session.userId)) {
    // Same response an ordinary user gets for a route that does not concern
    // them; no hint that a moderation surface exists here.
    throw forbidden('Not allowed.');
  }
}

export default withErrorHandling(async function handler(req: ApiRequest, res: ApiResponse) {
  requireMethod(req, 'GET', 'POST');

  const session = await requireSession(req);
  requireModerator(session);

  if (req.method === 'GET') {
    const { rows } = await query<{
      id: string;
      hour_id: number;
      display_name: string;
      tagline: string;
      link_url: string | null;
      logo_data_url: string | null;
      amount_cents: number;
      created_at: Date;
    }>(
      `SELECT b.id, b.hour_id, b.display_name, b.tagline, b.link_url, b.logo_data_url, b.amount_cents, b.created_at
         FROM bids b
        WHERE b.moderation = 'pending' AND b.status IN ('active', 'won')
        ORDER BY b.hour_id ASC, b.amount_cents DESC
        LIMIT 100`,
    );
    sendJson(res, 200, { pending: rows });
    return;
  }

  requireSameOrigin(req);
  requireCsrf(req, session);

  const body = await readJsonBody(req);
  const bidId = validateUuid(body.bidId, 'bidId');
  const decision = body.decision;
  if (decision !== 'approved' && decision !== 'rejected') {
    throw badRequest('Decision must be "approved" or "rejected".', 'bad_decision');
  }

  const { rowCount } = await query(`UPDATE bids SET moderation = $1 WHERE id = $2`, [decision, bidId]);
  if (rowCount === 0) throw badRequest('No such bid.', 'not_found');

  await audit({
    action: 'moderation.updated',
    actorId: session.userId,
    subject: `bid:${bidId}`,
    ipHash: hashIp(clientIp(req)),
    data: { decision },
  });

  sendJson(res, 200, { ok: true, bidId, decision });
});
