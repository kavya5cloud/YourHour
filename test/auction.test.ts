import test from 'node:test';
import assert from 'node:assert/strict';
import { loadEnv } from './setup.ts';

loadEnv();
const { splitProceeds, hourIdAt, hourStartsAt, HOUR_MS } = await import('../lib/auction.ts');

test('proceeds split into fee, net, and charity share using integer cents', () => {
  const split = splitProceeds(4200);
  // 2.9% of 4200 = 121.8 -> 122, plus the 30c fixed fee = 152
  assert.equal(split.feeCents, 152);
  assert.equal(split.netCents, 4048);
  // 50% of net, floored
  assert.equal(split.charityCents, 2024);
  assert.equal(split.feeCents + split.netCents, split.amountCents);
});

test('every part of the split is a whole number of cents', () => {
  for (const amount of [100, 137, 4200, 999_99, 1, 33]) {
    const split = splitProceeds(amount);
    for (const [name, value] of Object.entries(split)) {
      assert.ok(Number.isInteger(value), `${name} was not an integer for ${amount}: ${value}`);
    }
  }
});

test('the charity share never exceeds net, and rounding favours the ledger', () => {
  for (let amount = 100; amount < 5000; amount += 7) {
    const split = splitProceeds(amount);
    assert.ok(split.charityCents <= split.netCents, `charity exceeded net at ${amount}`);
    assert.ok(split.charityCents >= 0);
    // Flooring means we never promise a fraction of a cent we cannot pay.
    assert.ok(split.charityCents * 2 <= split.netCents);
  }
});

test('a fee larger than the amount cannot produce negative net', () => {
  const split = splitProceeds(1);
  assert.equal(split.netCents, 0);
  assert.equal(split.charityCents, 0);
  assert.ok(split.feeCents <= split.amountCents);
});

test('hour ids and hour boundaries are inverses of each other', () => {
  const id = hourIdAt(Date.now());
  const start = hourStartsAt(id);
  assert.equal(hourIdAt(start), id);
  // The instant before the start belongs to the previous hour.
  assert.equal(hourIdAt(start.getTime() - 1), id - 1);
  // The final millisecond still belongs to this hour.
  assert.equal(hourIdAt(start.getTime() + HOUR_MS - 1), id);
  assert.equal(hourIdAt(start.getTime() + HOUR_MS), id + 1);
});

test('hour boundaries land exactly on the hour', () => {
  const start = hourStartsAt(hourIdAt(Date.now()));
  assert.equal(start.getUTCMinutes(), 0);
  assert.equal(start.getUTCSeconds(), 0);
  assert.equal(start.getUTCMilliseconds(), 0);
});

test('hour ids advance by exactly one per hour', () => {
  const base = Date.now();
  assert.equal(hourIdAt(base + HOUR_MS) - hourIdAt(base), 1);
  assert.equal(hourIdAt(base + 24 * HOUR_MS) - hourIdAt(base), 24);
});
