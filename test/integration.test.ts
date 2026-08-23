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
  const { placeBid, runRollover, markPaid, getPublicState, hourIdAt, hourStartsAt, HOUR_MS } = auction;

  async function reset(): Promise<void> {
    await query(
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

  const listing = { displayName: 'example.com', tagline: 'A thing.', linkUrl: null, ipHash: null };

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

  test('a first bid takes the lead and appears in public state', async () => {
    await reset();
    const user = await makeUser('a@example.test');

    const result = await placeBid({ userId: user, amountCents: 5000, ...listing });
    assert.equal(result.amountCents, 5000);
    assert.equal(result.hourId, hourIdAt(Date.now()) + 1);

    const state = await getPublicState();
    assert.equal(state.nextHour.lead?.amountCents, 5000);
    // Unmoderated content is withheld from the public view.
    assert.equal(state.nextHour.lead?.name, 'Listing under review');
    assert.equal(state.nextHour.minBidCents, 5100);
  });

  test('a bid at or below the standing lead is rejected', async () => {
    await reset();
    const a = await makeUser('a@example.test');
    const b = await makeUser('b@example.test');

    await placeBid({ userId: a, amountCents: 5000, ...listing });

    await assert.rejects(
      () => placeBid({ userId: b, amountCents: 5000, ...listing }),
      /Bid \$51 or more/,
      'an equal bid must not take the lead',
    );
    await assert.rejects(() => placeBid({ userId: b, amountCents: 4900, ...listing }), /Bid \$51 or more/);

    // A bid clearing the increment succeeds and demotes the previous leader.
    const win = await placeBid({ userId: b, amountCents: 5100, ...listing });
    assert.equal(win.previousLeaderUserId, a);

    const { rows } = await query<{ status: string; amount_cents: number }>(
      `SELECT status, amount_cents FROM bids ORDER BY amount_cents ASC`,
    );
    assert.deepEqual(
      rows.map((r) => [r.amount_cents, r.status]),
      [[5000, 'outbid'], [5100, 'active']],
    );
  });

  test('concurrent bids cannot both take the lead', async () => {
    await reset();
    await commitNextHourRow();
    const users = await Promise.all(
      ['c1@example.test', 'c2@example.test', 'c3@example.test', 'c4@example.test', 'c5@example.test'].map(makeUser),
    );

    // Five bidders fire the identical amount at the same instant. Exactly one
    // may succeed; the rest must lose the race cleanly, not corrupt state.
    const results = await Promise.allSettled(
      users.map((userId) => placeBid({ userId, amountCents: 7000, ...listing })),
    );

    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    assert.equal(won.length, 1, `exactly one bid should win, got ${won.length}`);
    assert.equal(lost.length, 4);

    // And the database agrees: one active bid, at the expected price.
    const { rows } = await query<{ count: string }>(
      `SELECT count(*)::text FROM bids WHERE status = 'active'`,
    );
    assert.equal(rows[0]!.count, '1');

    const state = await getPublicState();
    assert.equal(state.nextHour.lead?.amountCents, 7000);
  });

  test('an escalating bid war leaves exactly one leader at the top price', async () => {
    await reset();
    await commitNextHourRow();
    const users = await Promise.all(
      Array.from({ length: 8 }, (_, i) => makeUser(`w${i}@example.test`)),
    );

    // Distinct amounts fired simultaneously; some will lose the race and retry
    // is not modelled, so we only assert the invariant that matters.
    const results = await Promise.allSettled(
      users.map((userId, i) => placeBid({ userId, amountCents: 10000 + i * 100, ...listing })),
    );
    assert.ok(results.some((r) => r.status === 'fulfilled'), 'at least one bid should land');

    const { rows } = await query<{ count: string; max: number }>(
      `SELECT count(*)::text AS count, max(amount_cents) AS max FROM bids WHERE status = 'active'`,
    );
    assert.equal(rows[0]!.count, '1', 'never more than one active bid per hour');

    // The single active bid must be the highest bid that was accepted.
    const { rows: top } = await query<{ amount_cents: number; status: string }>(
      `SELECT amount_cents, status FROM bids ORDER BY amount_cents DESC LIMIT 1`,
    );
    assert.equal(top[0]!.status, 'active', 'the highest accepted bid must be the leader');
  });

  /** Insert an hour that has already started, with bids, ready for rollover. */
  async function seedDueHour(amounts: Array<{ email: string; cents: number }>): Promise<number> {
    const hourId = hourIdAt(Date.now()); // the hour now in progress: bidding is over
    const startsAt = hourStartsAt(hourId);
    await query(
      `INSERT INTO hours (id, starts_at, ends_at, status) VALUES ($1, $2, $3, 'open')
       ON CONFLICT (id) DO UPDATE SET status = 'open'`,
      [hourId, startsAt, new Date(startsAt.getTime() + HOUR_MS)],
    );
    for (const entry of amounts) {
      const userId = await makeUser(entry.email);
      await query(
        `INSERT INTO bids (hour_id, user_id, amount_cents, display_name, tagline, moderation)
         VALUES ($1, $2, $3, 'example.com', 'A thing.', 'approved')`,
        [hourId, userId, entry.cents],
      );
    }
    return hourId;
  }

  test('rollover picks the top bidder and opens a payment window', async () => {
    await reset();
    calls.checkouts = 0;
    const hourId = await seedDueHour([
      { email: 'low@example.test', cents: 3000 },
      { email: 'high@example.test', cents: 9000 },
      { email: 'mid@example.test', cents: 6000 },
    ]);

    const report = await runRollover();
    assert.deepEqual(report.closed, [hourId]);
    assert.equal(calls.checkouts, 1, 'exactly one checkout should be created');

    const { rows } = await query<{ status: string; amount_cents: number; expires_at: Date }>(
      `SELECT p.status, p.amount_cents, p.expires_at FROM payments p WHERE p.hour_id = $1`,
      [hourId],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.amount_cents, 9000, 'the highest bidder must be selected');
    assert.equal(rows[0]!.status, 'pending');

    // The hour is not owned yet -- payment has not happened.
    const { rows: hourRows } = await query<{ status: string }>(`SELECT status FROM hours WHERE id = $1`, [hourId]);
    assert.equal(hourRows[0]!.status, 'awaiting_payment');

    const state = await getPublicState();
    assert.equal(state.currentHour.owner, null, 'an unpaid hour must have no owner on the public page');
  });

  test('running rollover twice does not double-charge or re-open a window', async () => {
    await reset();
    calls.checkouts = 0;
    const hourId = await seedDueHour([{ email: 'once@example.test', cents: 4000 }]);

    await runRollover();
    const second = await runRollover();

    assert.deepEqual(second.closed, [], 'the second run must find nothing to close');
    assert.equal(calls.checkouts, 1, 'a second checkout must not be created');

    const { rows } = await query<{ count: string }>(
      `SELECT count(*)::text FROM payments WHERE hour_id = $1`,
      [hourId],
    );
    assert.equal(rows[0]!.count, '1');
  });

  test('an hour becomes owned only after the payment path runs', async () => {
    await reset();
    const hourId = await seedDueHour([{ email: 'payer@example.test', cents: 8800 }]);
    await runRollover();

    const { rows } = await query<{ id: string }>(`SELECT id FROM payments WHERE hour_id = $1`, [hourId]);
    const paymentId = rows[0]!.id;

    assert.equal(await markPaid(paymentId, 'order_1'), true);

    const { rows: hourRows } = await query<{ status: string }>(`SELECT status FROM hours WHERE id = $1`, [hourId]);
    assert.equal(hourRows[0]!.status, 'owned');

    const state = await getPublicState();
    assert.equal(state.currentHour.owner?.paidCents, 8800);
    assert.equal(state.currentHour.owner?.name, 'example.com', 'approved listings display their real name');
    assert.equal(state.totals.raisedCents, 8800);
  });

  test('a duplicate payment confirmation is ignored', async () => {
    await reset();
    const hourId = await seedDueHour([{ email: 'dup@example.test', cents: 5500 }]);
    await runRollover();
    const { rows } = await query<{ id: string }>(`SELECT id FROM payments WHERE hour_id = $1`, [hourId]);
    const paymentId = rows[0]!.id;

    assert.equal(await markPaid(paymentId, 'order_1'), true);
    // A webhook retry must not credit the hour a second time.
    assert.equal(await markPaid(paymentId, 'order_1'), false, 'a repeat confirmation must be a no-op');

    const state = await getPublicState();
    assert.equal(state.totals.raisedCents, 5500, 'the total must not double');
    assert.equal(state.totals.hoursSold, 1);
  });

  test('concurrent payment confirmations credit the hour once', async () => {
    await reset();
    const hourId = await seedDueHour([{ email: 'race@example.test', cents: 6100 }]);
    await runRollover();
    const { rows } = await query<{ id: string }>(`SELECT id FROM payments WHERE hour_id = $1`, [hourId]);
    const paymentId = rows[0]!.id;

    // Two deliveries of the same event arriving at once.
    const results = await Promise.all([markPaid(paymentId, 'order_1'), markPaid(paymentId, 'order_1')]);
    assert.deepEqual(results.sort(), [false, true], 'exactly one confirmation may take effect');

    const state = await getPublicState();
    assert.equal(state.totals.raisedCents, 6100);
  });

  test('an expired payment window passes the hour to the next bidder', async () => {
    await reset();
    calls.checkouts = 0;
    const hourId = await seedDueHour([
      { email: 'first@example.test', cents: 9000 },
      { email: 'second@example.test', cents: 7000 },
    ]);

    await runRollover();
    assert.equal(calls.checkouts, 1);

    // Force the window to have elapsed.
    await query(`UPDATE payments SET expires_at = now() - interval '1 second' WHERE hour_id = $1`, [hourId]);

    const report = await runRollover();
    assert.deepEqual(report.expired, [hourId]);
    assert.deepEqual(report.promoted, [hourId], 'the next bidder should get a turn');
    assert.equal(calls.checkouts, 2);

    const { rows } = await query<{ amount_cents: number; status: string }>(
      `SELECT amount_cents, status FROM payments WHERE hour_id = $1 ORDER BY created_at ASC`,
      [hourId],
    );
    assert.deepEqual(
      rows.map((r) => [r.amount_cents, r.status]),
      [[9000, 'expired'], [7000, 'pending']],
      'the defaulting bidder is expired and the runner-up is now pending',
    );
  });

  test('an hour with no bids closes as unsold', async () => {
    await reset();
    const hourId = await seedDueHour([]);
    const report = await runRollover();
    assert.deepEqual(report.unsold, [hourId]);

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
    const { default: pool } = { default: globalThis.__theHourPool };
    await pool?.end();
  });
}
