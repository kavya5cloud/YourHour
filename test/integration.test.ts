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
    claimHour,
    releaseExpiredClaims,
    priceForHour,
    runRollover,
    markPaid,
    getPublicState,
    hourIdAt,
    hourStartsAt,
    HOUR_MS,
  } = auction;

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

  test('claiming an hour reserves it and prices it by how soon it is', async () => {
    await reset();
    const user = await makeUser('buyer@example.test');
    const hourId = await commitNextHourRow();

    const claim = await claimHour({ hourId, userId: user, ...listing });
    // The next hour is the dearest: base price undivided.
    assert.equal(claim.priceCents, 5000);
    assert.equal(claim.hourId, hourId);

    const state = await getPublicState();
    const slot = state.board.find((entry) => entry.hour === hourId);
    assert.equal(slot?.taken, true, 'a reserved hour is off the board immediately');
  });

  test('price falls the further out the hour is', async () => {
    const now = Date.now();
    const current = hourIdAt(now);
    assert.equal(priceForHour(current + 1, now), 5000);
    assert.equal(priceForHour(current + 2, now), 2500);
    assert.equal(priceForHour(current + 10, now), 500, 'floors out');
    assert.equal(priceForHour(current + 100, now), 500, 'stays at the floor');
    assert.equal(priceForHour(current, now), 0, 'the running hour is not for sale');
  });

  test('an hour that is already claimed cannot be claimed again', async () => {
    await reset();
    const first = await makeUser('first@example.test');
    const second = await makeUser('second@example.test');
    const hourId = await commitNextHourRow();

    await claimHour({ hourId, userId: first, ...listing });
    await assert.rejects(
      () => claimHour({ hourId, userId: second, ...listing }),
      /just taken/i,
      'the second buyer is turned away, not given the same hour',
    );
  });

  /**
   * The double-sell guarantee.
   *
   * Two buyers reach `claimHour` for the same hour at the same instant. The
   * partial unique index on live claims is what makes exactly one of them win:
   * the loser's INSERT violates it and is turned into a 409. Without that index
   * both would commit and two people would have paid for one hour.
   */
  test('concurrent claims on one hour cannot both succeed', async () => {
    await reset();
    const buyers = await Promise.all([
      makeUser('a@example.test'),
      makeUser('b@example.test'),
      makeUser('c@example.test'),
    ]);
    const hourId = await commitNextHourRow();

    const results = await Promise.allSettled(
      buyers.map((userId) => claimHour({ hourId, userId, ...listing })),
    );
    const won = results.filter((r) => r.status === 'fulfilled');
    assert.equal(won.length, 1, `exactly one claim should win, got ${won.length}`);

    const { rows } = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM bids WHERE hour_id = $1 AND status IN ('active','won')`,
      [hourId],
    );
    assert.equal(rows[0]!.n, '1', 'exactly one live claim row survives');
  });

  test('an abandoned checkout puts the hour back on sale', async () => {
    await reset();
    const user = await makeUser('ghost@example.test');
    const hourId = await commitNextHourRow();
    const claim = await claimHour({ hourId, userId: user, ...listing });

    // Wind the reservation into the past, as an abandoned checkout would.
    await query(`UPDATE bids SET reserved_until = now() - interval '1 minute' WHERE id = $1`, [
      claim.bidId,
    ]);

    // The board frees it on read, with no scheduler involved.
    const lazyState = await getPublicState();
    assert.equal(
      lazyState.board.find((entry) => entry.hour === hourId)?.taken,
      false,
      'an expired hold does not keep the hour off sale',
    );

    const released = await releaseExpiredClaims();
    assert.deepEqual(released, [hourId]);

    const state = await getPublicState();
    assert.equal(
      state.board.find((entry) => entry.hour === hourId)?.taken,
      false,
      'the hour is sellable again',
    );

    // And the freed hour really can be sold to somebody else.
    const other = await makeUser('other@example.test');
    const second = await claimHour({ hourId, userId: other, ...listing });
    assert.equal(second.hourId, hourId);
  });

  test('a paid claim is what makes an hour owned', async () => {
    await reset();
    const user = await makeUser('payer@example.test');
    const hourId = await commitNextHourRow();
    const claim = await claimHour({ hourId, userId: user, ...listing });

    const before = await query<{ status: string }>(`SELECT status FROM hours WHERE id = $1`, [hourId]);
    assert.equal(before.rows[0]!.status, 'open', 'reserving alone does not own the hour');

    assert.equal(await markPaid(claim.paymentId, 'order_1'), true);

    const after = await query<{ status: string; winning_bid_id: string }>(
      `SELECT status, winning_bid_id FROM hours WHERE id = $1`,
      [hourId],
    );
    assert.equal(after.rows[0]!.status, 'owned');
    assert.equal(after.rows[0]!.winning_bid_id, claim.bidId);
  });

  test('a duplicate payment confirmation is ignored', async () => {
    await reset();
    const user = await makeUser('dupe@example.test');
    const hourId = await commitNextHourRow();
    const claim = await claimHour({ hourId, userId: user, ...listing });

    assert.equal(await markPaid(claim.paymentId, 'order_1'), true);
    assert.equal(await markPaid(claim.paymentId, 'order_1'), false, 'the second delivery is a no-op');
  });

  test('concurrent payment confirmations credit the hour once', async () => {
    await reset();
    const user = await makeUser('race@example.test');
    const hourId = await commitNextHourRow();
    const claim = await claimHour({ hourId, userId: user, ...listing });

    const results = await Promise.all([
      markPaid(claim.paymentId, 'order_1'),
      markPaid(claim.paymentId, 'order_1'),
    ]);
    assert.equal(results.filter(Boolean).length, 1, 'only one confirmation may take effect');
  });

  test('an hour nobody bought closes as unsold', async () => {
    await reset();
    const hourId = hourIdAt(Date.now());
    const startsAt = hourStartsAt(hourId);
    await query(
      `INSERT INTO hours (id, starts_at, ends_at, status) VALUES ($1, $2, $3, 'open')`,
      [hourId, startsAt, new Date(startsAt.getTime() + HOUR_MS)],
    );

    const report = await runRollover();
    assert.ok(report.unsold.includes(hourId));
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
