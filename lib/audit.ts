/**
 * Append-only audit trail.
 *
 * Anything that moves money, changes who owns an hour, or grants access gets a
 * row here. Writes are best-effort: an audit failure is logged but never breaks
 * the user-facing request, since dropping a bid because logging hiccuped would
 * be the worse outcome.
 *
 * Never pass raw secrets, tokens, or full email addresses in `data`.
 */
import { query } from './db.ts';

export type AuditAction =
  | 'login.requested'
  | 'login.verified'
  | 'login.failed'
  | 'logout'
  | 'bid.placed'
  | 'bid.rejected'
  | 'hour.rolled'
  | 'hour.awaiting_payment'
  | 'hour.owned'
  | 'hour.forfeited'
  | 'hour.unsold'
  | 'payment.created'
  | 'payment.paid'
  | 'payment.expired'
  | 'payment.refunded'
  | 'webhook.received'
  | 'webhook.rejected'
  | 'moderation.updated';

export interface AuditEntry {
  action: AuditAction;
  actorId?: string | null;
  subject?: string | null;
  ipHash?: Buffer | null;
  data?: Record<string, unknown>;
}

export async function audit(entry: AuditEntry): Promise<void> {
  try {
    await query(
      `INSERT INTO audit_log (action, actor_id, subject, ip_hash, data)
       VALUES ($1, $2, $3, $4, $5)`,
      [entry.action, entry.actorId ?? null, entry.subject ?? null, entry.ipHash ?? null, entry.data ?? {}],
    );
  } catch (error) {
    console.error('audit write failed', { action: entry.action, message: (error as Error).message });
  }
}
