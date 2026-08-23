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
    owner: {
      name: string;
      tagline: string;
      link: string | null;
      logo: string | null;
      paidCents: number;
    } | null;
  };
  /** The hours on sale right now, soonest first. */
  board: Array<{
    hour: number;
    startsAt: string;
    priceCents: number;
    taken: boolean;
  }>;
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
      logo_data_url: string | null;
      amount_cents: number | null;
      moderation: string | null;
    }>(
      `SELECT h.status, h.ends_at, b.display_name, b.tagline, b.link_url, b.logo_data_url, b.amount_cents, b.moderation
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

  // The board: every hour inside the horizon, with its price and whether a
  // live claim already holds it. A reserved-but-unpaid hour counts as taken,
  // which is what stops two people buying the same slot.
  const horizon = env.auction.claimHorizonHours;
  const { rows: takenRows } = await query<{ hour_id: number }>(
    `SELECT hour_id FROM bids
      WHERE status IN ('active', 'won')
        AND (reserved_until IS NULL OR reserved_until > now())
        AND hour_id > $1 AND hour_id <= $2`,
    [currentId, currentId + horizon],
  );
  const taken = new Set(takenRows.map((row) => row.hour_id));
  const board = Array.from({ length: horizon }, (_, index) => {
    const hour = currentId + index + 1;
    return {
      hour,
      startsAt: hourStartsAt(hour).toISOString(),
      priceCents: priceForHour(hour, now),
      taken: taken.has(hour),
    };
  });

  return {
    board,
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
              logo: currentRow.moderation === 'approved' ? currentRow.logo_data_url : null,
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

// ------------------------------------------------------------------ rollover

export interface RolloverReport {
  /** Hours that started without ever being paid for. */
  unsold: number[];
  /** Hours put back on sale because their buyer abandoned checkout. */
  released: number[];
}

/**
 * The scheduled job.
 *
 * Under the claim model this is nearly nothing: hours are bought outright and
 * settled by the Polar webhook, so there is no winner to pick, no payment
 * window to open, and no next bidder to promote. All that remains is marking
 * hours that nobody bought, and returning abandoned reservations to the board.
 *
 * Still idempotent: every decision comes from stored timestamps, so running it
 * twice in a minute or not at all for a day both converge on the same state.
 */
export async function runRollover(): Promise<RolloverReport> {
  const released = await releaseExpiredClaims();

  // An hour that has started and was never paid for is simply unsold. Hours
  // that were paid for are already 'owned', set by the webhook, so they are
  // untouched by this.
  const { rows } = await query<{ id: number }>(
    `UPDATE hours SET status = 'unsold', settled_at = now()
      WHERE status = 'open' AND starts_at <= now()
      RETURNING id`,
  );

  return { unsold: rows.map((row) => row.id), released };
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
        WHERE id = $2 AND status IN ('open', 'awaiting_payment', 'forfeited')`,
      [payment.bid_id, payment.hour_id],
    );
    await client.query(`UPDATE bids SET status = 'won' WHERE id = $1`, [payment.bid_id]);

    // Paying through a link sent to that address proves control of it just as
    // well as clicking a sign-in link does, so it lifts the unverified cap too.
    await client.query(
      `UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1`,
      [payment.user_id],
    );

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

/**
 * Price of a given hour, in cents.
 *
 * The curve is the whole business model in one line: an hour costs more the
 * sooner it is. That is what "pay more, go sooner" means here -- a buyer moves
 * up by paying a nearer hour's price, never by displacing someone who already
 * bought. Nobody's slot can be taken away once paid for, which is why this
 * design needs no way to tell anyone their time changed.
 */
export function priceForHour(hourId: number, now: number = Date.now()): number {
  const currentId = hourIdAt(now);
  const hoursAway = hourId - currentId;
  if (hoursAway < 1) return 0; // in the past or already running: not for sale
  const { claimBaseCents, claimFloorCents } = env.auction;
  return Math.max(claimFloorCents, Math.round(claimBaseCents / hoursAway));
}

// ------------------------------------------------------------------ claiming

export interface ClaimInput {
  hourId: number;
  userId: string;
  displayName: string;
  tagline: string;
  linkUrl: string;
  logoDataUrl: string | null;
  ipHash: Buffer | null;
}

export interface ClaimResult {
  bidId: string;
  paymentId: string;
  hourId: number;
  priceCents: number;
}

/**
 * Reserve one specific hour for a buyer and open a payment for it.
 *
 * The concurrency argument is the partial unique index on `bids (hour_id)`
 * where the status is live: two buyers who reach this line at the same instant
 * cannot both succeed, because the second INSERT violates that index and is
 * turned into a 409 below. The database decides, not a read-then-write in
 * application code that a race could interleave.
 *
 * The reservation is what makes the hour un-sellable while its buyer is inside
 * Polar checkout. If they never finish, `releaseExpiredClaims` puts the hour
 * back on sale.
 */
export async function claimHour(input: ClaimInput): Promise<ClaimResult> {
  const now = Date.now();
  const currentId = hourIdAt(now);
  const hoursAway = input.hourId - currentId;
  if (hoursAway < 1) {
    throw conflict('That hour has already started. Pick a later one.', 'hour_past');
  }
  if (hoursAway > env.auction.claimHorizonHours) {
    throw conflict('That hour is too far out to claim yet.', 'hour_too_far');
  }

  const priceCents = priceForHour(input.hourId, now);
  const split = splitProceeds(priceCents);
  const reservedUntil = new Date(now + env.auction.reservationSeconds * 1000);

  return tx(async (client) => {
    await ensureHour(client, input.hourId);
    await lockHour(client, input.hourId);

    // Self-healing: drop this hour's own expired reservation before inserting.
    // The unique index counts any live claim, so without this an abandoned
    // checkout would keep the hour off sale until the cron job happened to run
    // -- which on a plan with once-a-day cron could be most of a day. Doing it
    // here, under the hour lock, means an abandoned hour is sellable the moment
    // its hold lapses, whether or not the scheduler ever fires.
    await client.query(
      `UPDATE bids SET status = 'lost', reserved_until = NULL
        WHERE hour_id = $1 AND status = 'active'
          AND reserved_until IS NOT NULL AND reserved_until < now()
          AND NOT EXISTS (
            SELECT 1 FROM payments p WHERE p.bid_id = bids.id AND p.status = 'paid'
          )`,
      [input.hourId],
    );

    const moderation = env.auction.autoApproveListings ? 'approved' : 'pending';
    let bidId: string;
    try {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO bids (hour_id, user_id, amount_cents, display_name, tagline,
                           link_url, logo_data_url, ip_hash, moderation, reserved_until)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id`,
        [
          input.hourId,
          input.userId,
          priceCents,
          input.displayName,
          input.tagline,
          input.linkUrl,
          input.logoDataUrl,
          input.ipHash,
          moderation,
          reservedUntil,
        ],
      );
      bidId = rows[0]!.id;
    } catch (error) {
      // 23505 is unique_violation: somebody else holds this hour.
      if ((error as { code?: string }).code === '23505') {
        throw conflict('That hour was just taken. Pick another.', 'hour_taken');
      }
      throw error;
    }

    const { rows: paymentRows } = await client.query<{ id: string }>(
      `INSERT INTO payments (hour_id, bid_id, user_id, amount_cents, fee_cents, charity_cents, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [input.hourId, bidId, input.userId, priceCents, split.feeCents, split.charityCents, reservedUntil],
    );

    return { bidId, paymentId: paymentRows[0]!.id, hourId: input.hourId, priceCents };
  });
}

/**
 * Release a claim immediately, for when checkout could not be opened.
 *
 * Without this the hour would sit reserved until `releaseExpiredClaims` caught
 * it, so a Polar outage would quietly take hours off sale for no reason.
 */
export async function releaseClaim(bidId: string): Promise<void> {
  await tx(async (client) => {
    await client.query(`UPDATE bids SET status = 'lost', reserved_until = NULL WHERE id = $1`, [bidId]);
    await client.query(
      `UPDATE payments SET status = 'failed' WHERE bid_id = $1 AND status = 'pending'`,
      [bidId],
    );
  });
}

/**
 * Put back any hour whose buyer never completed checkout.
 *
 * Runs from the same cron as everything else. Releasing is a status change
 * rather than a delete so an abandoned claim stays auditable.
 */
export async function releaseExpiredClaims(): Promise<number[]> {
  return tx(async (client) => {
    const { rows } = await client.query<{ id: string; hour_id: number }>(
      `UPDATE bids SET status = 'lost', reserved_until = NULL
        WHERE status = 'active'
          AND reserved_until IS NOT NULL
          AND reserved_until < now()
          AND NOT EXISTS (
            SELECT 1 FROM payments p WHERE p.bid_id = bids.id AND p.status = 'paid'
          )
        RETURNING id, hour_id`,
    );
    if (rows.length > 0) {
      await client.query(
        `UPDATE payments SET status = 'expired'
          WHERE bid_id = ANY($1::uuid[]) AND status = 'pending'`,
        [rows.map((row) => row.id)],
      );
    }
    return rows.map((row) => row.hour_id);
  });
}
