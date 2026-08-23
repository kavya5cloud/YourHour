/**
 * The auction itself.
 *
 * Everything that decides who owns an hour and for how much lives here, and
 * runs against the database clock inside a transaction. The browser is a
 * display surface: it never computes a winner, a price, a deadline, or a
 * payment state, and nothing it sends is trusted beyond validated bid input.
 *
 * The two integrity properties this module has to hold:
 *
 *  1. No two bids can both believe they took the lead. Every mutation locks the
 *     hour row (`SELECT ... FOR UPDATE`) as its first statement, so concurrent
 *     bids on the same hour serialise rather than interleaving a stale read
 *     with a write.
 *
 *  2. An hour is only marked paid by a verified provider webhook. Returning to
 *     the success URL in a browser proves nothing.
 */
import type pg from 'pg';
import { query, tx } from './db.ts';
import { env } from './env.ts';
import { audit } from './audit.ts';
import { conflict, badRequest } from './http.ts';
import { formatMoney } from './validate.ts';
import { createCheckout } from './polar.ts';
import { sendWinnerCheckout } from './mailer.ts';

export const HOUR_MS = 3_600_000;

/** Hour 1 begins at this instant; hour ids are the count of hours since. */
const EPOCH_MS = Date.UTC(2024, 0, 1, 0, 0, 0);

export function hourIdAt(instant: number | Date = Date.now()): number {
  const ms = instant instanceof Date ? instant.getTime() : instant;
  return Math.floor((ms - EPOCH_MS) / HOUR_MS) + 1;
}

export function hourStartsAt(hourId: number): Date {
  return new Date(EPOCH_MS + (hourId - 1) * HOUR_MS);
}

/** Placeholder shown in place of listing text that has not been reviewed. */
const UNDER_REVIEW = 'Listing under review';

// ---------------------------------------------------------------- money

export interface Split {
  amountCents: number;
  feeCents: number;
  netCents: number;
  charityCents: number;
}

/**
 * Split a paid amount into provider fee, net, and the charity share.
 *
 * All integer arithmetic on cents. `Math.floor` on the charity share means any
 * sub-cent remainder stays on our side of the ledger rather than being promised
 * and not delivered.
 */
export function splitProceeds(amountCents: number): Split {
  const feeCents = Math.min(
    amountCents,
    Math.round((amountCents * env.auction.feeBasisPoints) / 10_000) + env.auction.feeFixedCents,
  );
  const netCents = Math.max(0, amountCents - feeCents);
  const charityCents = Math.floor((netCents * env.auction.charityBasisPoints) / 10_000);
  return { amountCents, feeCents, netCents, charityCents };
}

// ------------------------------------------------------------ hour rows

/** Create the row for an hour if it does not exist yet. Safe to call often. */
async function ensureHour(client: pg.PoolClient | null, hourId: number): Promise<void> {
  const runner = client ? client.query.bind(client) : query;
  const startsAt = hourStartsAt(hourId);
  await runner(
    `INSERT INTO hours (id, starts_at, ends_at, status)
     VALUES ($1, $2, $3, 'open')
     ON CONFLICT (id) DO NOTHING`,
    [hourId, startsAt, new Date(startsAt.getTime() + HOUR_MS)],
  );
}

/** Lock an hour for update, creating it first if needed. */
async function lockHour(client: pg.PoolClient, hourId: number) {
  await ensureHour(client, hourId);
  const { rows } = await client.query<{
    id: number;
    status: string;
    starts_at: Date;
    ends_at: Date;
    winning_bid_id: string | null;
  }>(`SELECT id, status, starts_at, ends_at, winning_bid_id FROM hours WHERE id = $1 FOR UPDATE`, [hourId]);
  const row = rows[0];
  if (!row) throw new Error(`Hour ${hourId} vanished after insert`);
  return row;
}

// ---------------------------------------------------------- public view

export interface PublicState {
  serverTime: string;
  currentHour: {
    id: number;
    endsAt: string;
    status: string;
    owner: { name: string; tagline: string; link: string | null; paidCents: number } | null;
  };
  nextHour: {
    id: number;
    startsAt: string;
    lead: { name: string; amountCents: number } | null;
    minBidCents: number;
  };
  archive: Array<{ hour: number; name: string; amountCents: number }>;
  totals: { hoursSold: number; raisedCents: number; charityCents: number; highestCents: number };
}

/**
 * Everything the homepage needs, in one read.
 *
 * Deliberately excludes emails, user ids, bid ids, and losing bidders' details:
 * a public endpoint should not become a directory of who is bidding what.
 */
export async function getPublicState(): Promise<PublicState> {
  const now = Date.now();
  const currentId = hourIdAt(now);
  const nextId = currentId + 1;

  const [current, lead, archive, totals] = await Promise.all([
    query<{
      status: string;
      ends_at: Date;
      display_name: string | null;
      tagline: string | null;
      link_url: string | null;
      amount_cents: number | null;
      moderation: string | null;
    }>(
      `SELECT h.status, h.ends_at, b.display_name, b.tagline, b.link_url, b.amount_cents, b.moderation
         FROM hours h
         LEFT JOIN bids b ON b.id = h.winning_bid_id
        WHERE h.id = $1`,
      [currentId],
    ),
    query<{ display_name: string; amount_cents: number; moderation: string }>(
      `SELECT display_name, amount_cents, moderation
         FROM bids
        WHERE hour_id = $1 AND status = 'active'
        ORDER BY amount_cents DESC, created_at ASC
        LIMIT 1`,
      [nextId],
    ),
    query<{ id: number; display_name: string; amount_cents: number; moderation: string }>(
      `SELECT h.id, b.display_name, b.amount_cents, b.moderation
         FROM hours h
         JOIN bids b ON b.id = h.winning_bid_id
        WHERE h.status = 'owned' AND h.id < $1
        ORDER BY h.id DESC
        LIMIT 6`,
      [currentId],
    ),
    query<{ hours_sold: string; raised: string | null; highest: number | null }>(
      `SELECT count(*)::text AS hours_sold,
              sum(p.amount_cents)::text AS raised,
              max(p.amount_cents) AS highest
         FROM payments p
        WHERE p.status = 'paid'`,
    ),
  ]);

  const currentRow = current.rows[0];
  const leadRow = lead.rows[0];
  const raisedCents = Number.parseInt(totals.rows[0]?.raised ?? '0', 10) || 0;

  // Unreviewed text never reaches a visitor verbatim.
  const display = (value: string | null, moderation: string | null): string =>
    moderation === 'approved' ? (value ?? '') : UNDER_REVIEW;

  return {
    serverTime: new Date(now).toISOString(),
    currentHour: {
      id: currentId,
      endsAt: (currentRow?.ends_at ?? new Date(EPOCH_MS + currentId * HOUR_MS)).toISOString(),
      status: currentRow?.status ?? 'open',
      owner:
        currentRow && currentRow.display_name !== null && currentRow.status === 'owned'
          ? {
              name: display(currentRow.display_name, currentRow.moderation),
              tagline: currentRow.moderation === 'approved' ? (currentRow.tagline ?? '') : '',
              link: currentRow.moderation === 'approved' ? currentRow.link_url : null,
              paidCents: currentRow.amount_cents ?? 0,
            }
          : null,
    },
    nextHour: {
      id: nextId,
      startsAt: hourStartsAt(nextId).toISOString(),
      lead: leadRow
        ? { name: display(leadRow.display_name, leadRow.moderation), amountCents: leadRow.amount_cents }
        : null,
      minBidCents: leadRow
        ? leadRow.amount_cents + env.auction.minIncrementCents
        : env.auction.minBidCents,
    },
    archive: archive.rows.map((row) => ({
      hour: row.id,
      name: display(row.display_name, row.moderation),
      amountCents: row.amount_cents,
    })),
    totals: {
      hoursSold: Number.parseInt(totals.rows[0]?.hours_sold ?? '0', 10) || 0,
      raisedCents,
      charityCents: splitProceeds(raisedCents).charityCents,
      highestCents: totals.rows[0]?.highest ?? 0,
    },
  };
}

// -------------------------------------------------------------- bidding

export interface PlaceBidInput {
  userId: string;
  amountCents: number;
  displayName: string;
  tagline: string;
  linkUrl: string | null;
  ipHash: Buffer | null;
}

export interface PlaceBidResult {
  bidId: string;
  hourId: number;
  amountCents: number;
  previousLeaderUserId: string | null;
}

/**
 * Place a bid on the next hour.
 *
 * The amount is re-checked against the standing lead *inside* the lock. The
 * client's idea of the current price is treated as advisory only; two bidders
 * submitting the same amount at the same moment cannot both succeed.
 */
export async function placeBid(input: PlaceBidInput): Promise<PlaceBidResult> {
  return tx(async (client) => {
    const now = Date.now();
    const hourId = hourIdAt(now) + 1;
    const hour = await lockHour(client, hourId);

    if (hour.status !== 'open') {
      throw conflict('Bidding on that hour has closed.', 'hour_closed');
    }
    // The row lock does not stop the clock; re-check the deadline under it.
    if (hour.starts_at.getTime() <= now) {
      throw conflict('That hour just started. Bid on the next one.', 'hour_started');
    }

    const { rows: leadRows } = await client.query<{ id: string; user_id: string; amount_cents: number }>(
      `SELECT id, user_id, amount_cents
         FROM bids
        WHERE hour_id = $1 AND status = 'active'
        ORDER BY amount_cents DESC, created_at ASC
        LIMIT 1`,
      [hourId],
    );
    const lead = leadRows[0];

    const required = lead ? lead.amount_cents + env.auction.minIncrementCents : env.auction.minBidCents;
    if (input.amountCents < required) {
      throw conflict(`Bid ${formatMoney(required)} or more to take the lead.`, 'bid_too_low');
    }

    // Demote the standing bids before inserting, so 'active' always holds
    // exactly the live leader for this hour.
    await client.query(`UPDATE bids SET status = 'outbid' WHERE hour_id = $1 AND status = 'active'`, [hourId]);

    const moderation = env.auction.autoApproveListings ? 'approved' : 'pending';
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO bids (hour_id, user_id, amount_cents, display_name, tagline, link_url, ip_hash, moderation)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        hourId,
        input.userId,
        input.amountCents,
        input.displayName,
        input.tagline,
        input.linkUrl,
        input.ipHash,
        moderation,
      ],
    );
    const bidId = rows[0]!.id;

    return {
      bidId,
      hourId,
      amountCents: input.amountCents,
      previousLeaderUserId: lead && lead.user_id !== input.userId ? lead.user_id : null,
    };
  });
}

// ------------------------------------------------------------- rollover

/**
 * Open a payment window for a bid: record the attempt, create the hosted
 * checkout, and hand back the URL to email.
 *
 * The payment row is written before the provider call so that a crash between
 * the two leaves an auditable pending record rather than a silent gap.
 */
async function openPaymentWindow(
  client: pg.PoolClient,
  bid: { id: string; user_id: string; amount_cents: number; email: string },
  hourId: number,
): Promise<{ paymentId: string; checkoutUrl: string } | null> {
  const split = splitProceeds(bid.amount_cents);
  const expiresAt = new Date(Date.now() + env.auction.paymentWindowSeconds * 1000);

  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO payments (hour_id, bid_id, user_id, amount_cents, fee_cents, charity_cents, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [hourId, bid.id, bid.user_id, bid.amount_cents, split.feeCents, split.charityCents, expiresAt],
  );
  const paymentId = rows[0]!.id;

  let checkout;
  try {
    checkout = await createCheckout({
      amountCents: bid.amount_cents,
      email: bid.email,
      hourId,
      bidId: bid.id,
      paymentId,
    });
  } catch (error) {
    // Provider unreachable: fail this attempt so the next pass can promote the
    // following bidder instead of leaving the hour stuck.
    await client.query(`UPDATE payments SET status = 'failed' WHERE id = $1`, [paymentId]);
    console.error('checkout creation failed', { hourId, message: (error as Error).message });
    return null;
  }

  await client.query(`UPDATE payments SET provider_checkout_id = $1 WHERE id = $2`, [checkout.id, paymentId]);
  return { paymentId, checkoutUrl: checkout.url };
}

/** The highest live bid for an hour that has not already had its turn. */
async function nextEligibleBid(client: pg.PoolClient, hourId: number) {
  const { rows } = await client.query<{
    id: string;
    user_id: string;
    amount_cents: number;
    email: string;
  }>(
    `SELECT b.id, b.user_id, b.amount_cents, u.email
       FROM bids b
       JOIN users u ON u.id = b.user_id
      WHERE b.hour_id = $1
        AND b.status IN ('active', 'outbid')
        AND u.disabled_at IS NULL
        -- A bid whose only payment rows are 'failed' never got a usable
        -- checkout link, so it is still owed its turn. Excluding every bid with
        -- any payment row would silently skip the top bidder forever after one
        -- provider outage.
        AND NOT EXISTS (
          SELECT 1 FROM payments p WHERE p.bid_id = b.id AND p.status <> 'failed'
        )
        -- ...but not forever: give up on a bid after three failed attempts so a
        -- sustained provider outage cannot stall the hour indefinitely.
        AND (SELECT count(*) FROM payments p2 WHERE p2.bid_id = b.id AND p2.status = 'failed') < 3
      ORDER BY b.amount_cents DESC, b.created_at ASC
      LIMIT 1`,
    [hourId],
  );
  return rows[0] ?? null;
}

export interface RolloverReport {
  closed: number[];
  expired: number[];
  promoted: number[];
  unsold: number[];
}

/**
 * The scheduled job. Idempotent: running it twice in the same minute, or not at
 * all for several hours, both converge to the correct state, because every
 * decision is derived from stored timestamps rather than from having been
 * invoked at exactly the right moment.
 */
export async function runRollover(): Promise<RolloverReport> {
  const report: RolloverReport = { closed: [], expired: [], promoted: [], unsold: [] };
  const now = Date.now();
  const currentId = hourIdAt(now);

  // 1. Close every hour whose bidding period has elapsed.
  const { rows: dueRows } = await query<{ id: number }>(
    `SELECT id FROM hours WHERE status = 'open' AND starts_at <= now() ORDER BY id ASC LIMIT 50`,
  );

  for (const due of dueRows) {
    const outcome = await tx(async (client) => {
      const hour = await lockHour(client, due.id);
      if (hour.status !== 'open') return null; // another pass got here first

      const winner = await nextEligibleBid(client, due.id);
      if (!winner) {
        await client.query(`UPDATE hours SET status = 'unsold', settled_at = now() WHERE id = $1`, [due.id]);
        report.unsold.push(due.id);
        return null;
      }

      const opened = await openPaymentWindow(client, winner, due.id);
      if (!opened) return null; // retried on the next pass

      await client.query(`UPDATE bids SET status = 'won' WHERE id = $1`, [winner.id]);
      await client.query(
        `UPDATE hours SET status = 'awaiting_payment', winning_bid_id = $1 WHERE id = $2`,
        [winner.id, due.id],
      );
      report.closed.push(due.id);
      return { email: winner.email, amount: winner.amount_cents, url: opened.checkoutUrl, hourId: due.id };
    });

    if (outcome) {
      await audit({
        action: 'hour.awaiting_payment',
        subject: `hour:${outcome.hourId}`,
        data: { amountCents: outcome.amount },
      });
      // Email outside the transaction: a mail failure must not roll back a
      // committed auction result.
      await sendWinnerCheckout(outcome.email, {
        hour: outcome.hourId,
        amount: formatMoney(outcome.amount),
        checkoutUrl: outcome.url,
        minutes: Math.round(env.auction.paymentWindowSeconds / 60),
      }).catch((error) => console.error('winner email failed', { message: (error as Error).message }));
    }
  }

  // 2. Expire payment windows that ran out, and offer the hour to the next bidder.
  const { rows: staleRows } = await query<{ hour_id: number }>(
    `SELECT DISTINCT hour_id FROM payments WHERE status = 'pending' AND expires_at < now() LIMIT 50`,
  );

  for (const stale of staleRows) {
    const outcome = await tx(async (client) => {
      await lockHour(client, stale.hour_id);

      const { rows: expiredRows } = await client.query<{ id: string; bid_id: string }>(
        `UPDATE payments SET status = 'expired'
          WHERE hour_id = $1 AND status = 'pending' AND expires_at < now()
          RETURNING id, bid_id`,
        [stale.hour_id],
      );
      if (expiredRows.length === 0) return null;

      for (const expired of expiredRows) {
        await client.query(`UPDATE bids SET status = 'forfeited' WHERE id = $1`, [expired.bid_id]);
      }
      report.expired.push(stale.hour_id);

      // The hour may already be over; only promote if there is time left to own it.
      const { rows: hourRows } = await client.query<{ ends_at: Date }>(
        `SELECT ends_at FROM hours WHERE id = $1`,
        [stale.hour_id],
      );
      const endsAt = hourRows[0]?.ends_at;
      if (!endsAt || endsAt.getTime() <= Date.now()) {
        await client.query(
          `UPDATE hours SET status = 'forfeited', winning_bid_id = NULL, settled_at = now() WHERE id = $1`,
          [stale.hour_id],
        );
        return null;
      }

      const next = await nextEligibleBid(client, stale.hour_id);
      if (!next) {
        await client.query(
          `UPDATE hours SET status = 'forfeited', winning_bid_id = NULL, settled_at = now() WHERE id = $1`,
          [stale.hour_id],
        );
        return null;
      }

      const opened = await openPaymentWindow(client, next, stale.hour_id);
      if (!opened) return null;

      await client.query(`UPDATE bids SET status = 'won' WHERE id = $1`, [next.id]);
      await client.query(`UPDATE hours SET winning_bid_id = $1 WHERE id = $2`, [next.id, stale.hour_id]);
      report.promoted.push(stale.hour_id);
      return { email: next.email, amount: next.amount_cents, url: opened.checkoutUrl, hourId: stale.hour_id };
    });

    if (outcome) {
      await sendWinnerCheckout(outcome.email, {
        hour: outcome.hourId,
        amount: formatMoney(outcome.amount),
        checkoutUrl: outcome.url,
        minutes: Math.round(env.auction.paymentWindowSeconds / 60),
      }).catch((error) => console.error('promotion email failed', { message: (error as Error).message }));
    }
  }

  // 3. Make sure the hour currently taking bids exists.
  await ensureHour(null, currentId + 1);

  return report;
}

// -------------------------------------------------------------- payment

/**
 * Mark a payment paid. Called only from the verified-webhook path.
 *
 * Idempotent by design: a duplicate delivery finds the payment already `paid`
 * and returns without double-crediting the hour.
 */
export async function markPaid(paymentId: string, providerOrderId: string | null): Promise<boolean> {
  return tx(async (client) => {
    const { rows } = await client.query<{ hour_id: number; bid_id: string; user_id: string; amount_cents: number }>(
      `UPDATE payments
          SET status = 'paid', paid_at = now(), provider_order_id = COALESCE($2, provider_order_id)
        WHERE id = $1 AND status = 'pending'
        RETURNING hour_id, bid_id, user_id, amount_cents`,
      [paymentId, providerOrderId],
    );
    const payment = rows[0];
    if (!payment) return false; // already settled, expired, or unknown

    await lockHour(client, payment.hour_id);
    await client.query(
      `UPDATE hours SET status = 'owned', winning_bid_id = $1, settled_at = now()
        WHERE id = $2 AND status IN ('awaiting_payment', 'forfeited')`,
      [payment.bid_id, payment.hour_id],
    );
    await client.query(`UPDATE bids SET status = 'won' WHERE id = $1`, [payment.bid_id]);

    await audit({
      action: 'payment.paid',
      actorId: payment.user_id,
      subject: `hour:${payment.hour_id}`,
      data: { amountCents: payment.amount_cents, paymentId },
    });
    return true;
  });
}

/** Mark a payment refunded and release the hour. */
export async function markRefunded(paymentId: string): Promise<boolean> {
  return tx(async (client) => {
    const { rows } = await client.query<{ hour_id: number; bid_id: string }>(
      `UPDATE payments SET status = 'refunded'
        WHERE id = $1 AND status IN ('paid', 'pending')
        RETURNING hour_id, bid_id`,
      [paymentId],
    );
    const payment = rows[0];
    if (!payment) return false;

    await lockHour(client, payment.hour_id);
    await client.query(
      `UPDATE hours SET status = 'forfeited', winning_bid_id = NULL WHERE id = $1`,
      [payment.hour_id],
    );
    await audit({ action: 'payment.refunded', subject: `hour:${payment.hour_id}`, data: { paymentId } });
    return true;
  });
}

/** Look up a payment by the provider's checkout id, for webhook resolution. */
export async function findPaymentByCheckout(checkoutId: string): Promise<{ id: string } | null> {
  const { rows } = await query<{ id: string }>(`SELECT id FROM payments WHERE provider_checkout_id = $1`, [
    checkoutId,
  ]);
  return rows[0] ?? null;
}

/** Guard used by the bid endpoint before doing any expensive work. */
export function assertBiddingWindowOpen(): void {
  const now = Date.now();
  const nextStart = hourStartsAt(hourIdAt(now) + 1).getTime();
  if (nextStart - now <= 0) throw badRequest('Bidding is momentarily closed while the hour rolls over.', 'rolling_over');
}
