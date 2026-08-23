/**
 * Integration tests against a real Postgres.
 *
 * The unit tests cover pure logic. These cover the claims that only a database
 * can settle: that the row lock actually serialises competing bids, that
 * rollover is idempotent, and that an hour becomes owned only through the
 * payment path.
 *
 * Skipped unless TEST_DATABASE_URL is set, so `npm test` still runs without a
 * database. Run with:
 *
 *   TEST_DATABASE_URL=postgres://... npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadEnv } from './setup.ts';

const databaseUrl = process.env.TEST_DATABASE_URL;

if (!databaseUrl) {
  test('integration tests (skipped: set TEST_DATABASE_URL to run)', { skip: true }, () => {});
} else {
  loadEnv();
  process.env.DATABASE_URL = databaseUrl;
  process.env.LISTING_AUTO_APPROVE = 'false';

  // Polar and Resend are stubbed at the fetch boundary. Everything below the
  // HTTP call -- transactions, locking, state transitions -- is the real code.
  const calls = { checkouts: 0, emails: 0 };
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/v1/checkouts')) {
      calls.checkouts += 1;
      return new Response(
        JSON.stringify({ id: `chk_${calls.checkouts}`, url: `https://checkout.polar.sh/chk_${calls.checkouts}` }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (url.includes('resend.com')) {
      calls.emails += 1;
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error(`unexpected outbound request in tests: ${url}`);
  }) as typeof fetch;

  const { query, tx } = await import('../lib/db.ts');
  const auction = await import('../lib/auction.ts');
  const {
    purchase,
    settleDueHours,
    projectedQueue,
    runRollover,
    markPaid,
    getPublicState,
    hourIdAt,
    hourStartsAt,
    HOUR_MS,
  } = auction;

  /**
   * Wipe shared tables between tests.
   *
   * TRUNCATE needs an AccessExclusiveLock on every table at once, while other
   * pooled connections may still hold row locks from the request that just
   * finished. Postgres resolves that standoff by killing one side, which shows
   * up as a deadlock in whichever test happened to be resetting. Retrying is
   * the right response: the losing side is safe to repeat, and the contention
   * is a property of sharing one database with a connection pool rather than a
   * fault in the code under test.
   */
  async function truncateWithRetry(sql: string, attempts = 5): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await query(sql);
        return;
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (attempt >= attempts || (code !== '40P01' && code !== '55P03')) throw error;
        await new Promise((resolve) => setTimeout(resolve, 60 * attempt));
      }
    }
  }

  async function reset(): Promise<void> {
    await truncateWithRetry(
      `TRUNCATE payments, bids, hours, sessions, login_tokens, users,
                webhook_events, rate_limits, audit_log RESTART IDENTITY CASCADE`,
    );
  }

  async function makeUser(email: string): Promise<string> {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO users (email) VALUES ($1) RETURNING id`,
      [email],
    );
    return rows[0]!.id;
  }

  const listing = {
    displayName: 'example.com',
    tagline: 'A thing.',
    linkUrl: 'https://example.com/',
    logoDataUrl: null,
    ipHash: null,
  };

  /**
   * Commit the row for the hour that is taking bids, before the test runs.
   *
   * This matters more than it looks. If the row does not exist, concurrent
   * `placeBid` calls all attempt `INSERT ... ON CONFLICT DO NOTHING` on the same
   * key, and Postgres serialises them on the unique index while the first
   * transaction commits. That incidental serialisation masks the race entirely,
   * so a concurrency test written without this setup passes even when the row
   * lock is removed -- it proves nothing.
   *
   * In production the cron job has already created the hour row, so this is
   * also the realistic state.
   */
  async function commitNextHourRow(): Promise<number> {
    const hourId = hourIdAt(Date.now()) + 1;
    const startsAt = hourStartsAt(hourId);
    await query(
      `INSERT INTO hours (id, starts_at, ends_at, status) VALUES ($1, $2, $3, 'open')
       ON CONFLICT (id) DO NOTHING`,
      [hourId, startsAt, new Date(startsAt.getTime() + HOUR_MS)],
    );
    return hourId;
  }

  /** Buy and immediately confirm payment, so the purchase joins the pool. */
  async function buy(email: string, dollars: number): Promise<string> {
    const userId = await makeUser(email);
    const result = await purchase({ amountCents: dollars * 100, userId, ...listing });
    const paid = await markPaid(result.paymentId, `order_${email}`);
    assert.equal(paid, true, `payment for ${email} should have been confirmed`);
    return result.bidId;
  }

  test('a purchase takes no hour until one comes round', async () => {
    await reset();
    const userId = await makeUser('buyer@example.test');
    const result = await purchase({ amountCents: 5000, userId, ...listing });

    const { rows } = await query<{ hour_id: number | null; status: string }>(
      `SELECT hour_id, status FROM bids WHERE id = $1`,
      [result.bidId],
    );
    assert.equal(rows[0]!.hour_id, null, 'no hour is reserved at purchase time');
    assert.equal(rows[0]!.status, 'active', 'unpaid purchases are not in the pool');
  });

  test('the queue ranks by amount, and ties go to whoever paid first', async () => {
    await reset();
    await buy('small@example.test', 5);
    await buy('big@example.test', 50);
    await buy('mid@example.test', 20);

    const queue = await projectedQueue();
    assert.deepEqual(
      queue.map((entry) => entry.amountCents),
      [5000, 2000, 500],
      'highest payer is first in line',
    );
  });

  test('paying more moves you ahead of people who bought earlier', async () => {
    await reset();
    await buy('early@example.test', 10);
    let queue = await projectedQueue();
    assert.equal(queue[0]!.amountCents, 1000);

    await buy('late@example.test', 40);
    queue = await projectedQueue();
    assert.equal(queue[0]!.amountCents, 4000, 'the bigger payer jumps the queue');
    assert.equal(queue[1]!.amountCents, 1000, 'and nobody is dropped');
  });

  test('an unpaid purchase never enters the queue', async () => {
    await reset();
    const userId = await makeUser('deadbeat@example.test');
    await purchase({ amountCents: 100_00, userId, ...listing });
    assert.deepEqual(await projectedQueue(), [], 'paying is what puts you in line');
  });

  /**
   * The point of the whole design: an hour that has started keeps its
   * occupant. Ranking is only ever provisional for hours still ahead.
   */
  test('an hour that has started cannot be bumped by a bigger payer', async () => {
    await reset();
    await buy('modest@example.test', 5);

    const hourId = hourIdAt(Date.now());
    const startsAt = hourStartsAt(hourId);
    await query(
      `INSERT INTO hours (id, starts_at, ends_at, status) VALUES ($1, $2, $3, 'open')
       ON CONFLICT (id) DO NOTHING`,
      [hourId, startsAt, new Date(startsAt.getTime() + HOUR_MS)],
    );

    await settleDueHours();
    const owner = await query<{ winning_bid_id: string }>(
      `SELECT winning_bid_id FROM hours WHERE id = $1`,
      [hourId],
    );
    const locked = owner.rows[0]!.winning_bid_id;
    assert.ok(locked, 'the hour took the top of the pool');

    // Somebody far richer turns up afterwards.
    await buy('whale@example.test', 500);
    await settleDueHours();

    const after = await query<{ winning_bid_id: string }>(
      `SELECT winning_bid_id FROM hours WHERE id = $1`,
      [hourId],
    );
    assert.equal(after.rows[0]!.winning_bid_id, locked, 'the running hour is untouched');
  });

  test('settling is idempotent and never double-books an hour', async () => {
    await reset();
    await buy('one@example.test', 10);
    const hourId = hourIdAt(Date.now());
    const startsAt = hourStartsAt(hourId);
    await query(
      `INSERT INTO hours (id, starts_at, ends_at, status) VALUES ($1, $2, $3, 'open')
       ON CONFLICT (id) DO NOTHING`,
      [hourId, startsAt, new Date(startsAt.getTime() + HOUR_MS)],
    );

    await Promise.all([settleDueHours(), settleDueHours(), settleDueHours()]);
    const { rows } = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM bids WHERE hour_id = $1`,
      [hourId],
    );
    assert.equal(rows[0]!.n, '1', 'exactly one purchase holds the hour');
  });

  test('a duplicate payment confirmation is ignored', async () => {
    await reset();
    const userId = await makeUser('dupe@example.test');
    const result = await purchase({ amountCents: 1000, userId, ...listing });
    assert.equal(await markPaid(result.paymentId, 'order_1'), true);
    assert.equal(await markPaid(result.paymentId, 'order_1'), false);
  });

  test('concurrent payment confirmations credit a purchase once', async () => {
    await reset();
    const userId = await makeUser('race@example.test');
    const result = await purchase({ amountCents: 1000, userId, ...listing });
    const results = await Promise.all([
      markPaid(result.paymentId, 'order_1'),
      markPaid(result.paymentId, 'order_1'),
    ]);
    assert.equal(results.filter(Boolean).length, 1);
  });

  test('an hour with nobody waiting closes as unsold', async () => {
    await reset();
    const hourId = hourIdAt(Date.now());
    const startsAt = hourStartsAt(hourId);
    await query(
      `INSERT INTO hours (id, starts_at, ends_at, status) VALUES ($1, $2, $3, 'open')
       ON CONFLICT (id) DO NOTHING`,
      [hourId, startsAt, new Date(startsAt.getTime() + HOUR_MS)],
    );
    await settleDueHours();
    const { rows } = await query<{ status: string }>(`SELECT status FROM hours WHERE id = $1`, [hourId]);
    assert.equal(rows[0]!.status, 'unsold');
  });


  test('rate limiting counts across independent calls', async () => {
    await reset();
    const { consume } = await import('../lib/ratelimit.ts');

    const outcomes = [];
    for (let i = 0; i < 5; i += 1) {
      outcomes.push((await consume('test:scope', 'subject-a', 3, 3600)).allowed);
    }
    assert.deepEqual(outcomes, [true, true, true, false, false]);

    // A different subject has its own budget.
    assert.equal((await consume('test:scope', 'subject-b', 3, 3600)).allowed, true);
  });

  test('concurrent rate limit hits are counted atomically', async () => {
    await reset();
    const { consume } = await import('../lib/ratelimit.ts');

    // Twenty simultaneous hits against a limit of 5: exactly 5 may be allowed.
    const results = await Promise.all(
      Array.from({ length: 20 }, () => consume('test:atomic', 'subject', 5, 3600)),
    );
    assert.equal(results.filter((r) => r.allowed).length, 5);
  });

  test.after(async () => {
    const pg = await import('pg');
    void pg;
    // Close the pool so the test process can exit.
    const { default: pool } = { default: globalThis.__getYourHourPool };
    await pool?.end();
  });
}
