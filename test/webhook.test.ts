import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { loadEnv } from './setup.ts';

loadEnv();
const { verifyWebhook } = await import('../lib/polar.ts');

const SECRET = 'whsec_dGVzdC13ZWJob29rLXNlY3JldC12YWx1ZQ==';
const rawKey = Buffer.from(SECRET.slice('whsec_'.length), 'base64');

/** Build a correctly signed delivery, the way the provider would. */
function sign(body: string, options: { id?: string; timestamp?: number; key?: Buffer } = {}) {
  const id = options.id ?? 'msg_test_1';
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', options.key ?? rawKey)
    .update(`${id}.${timestamp}.${body}`, 'utf8')
    .digest('base64');
  return {
    'webhook-id': id,
    'webhook-timestamp': String(timestamp),
    'webhook-signature': `v1,${signature}`,
  };
}

const BODY = JSON.stringify({ type: 'order.paid', data: { id: 'order_1', metadata: { payment_id: 'p1' } } });

test('a correctly signed delivery verifies', () => {
  const event = verifyWebhook(Buffer.from(BODY), sign(BODY));
  assert.equal(event.type, 'order.paid');
  assert.equal(event.id, 'msg_test_1');
  assert.equal((event.data as { id: string }).id, 'order_1');
});

test('a tampered body fails even though the signature is well-formed', () => {
  const headers = sign(BODY);
  const tampered = BODY.replace('order_1', 'order_2');
  assert.throws(() => verifyWebhook(Buffer.from(tampered), headers), /signature mismatch/);
});

test('re-serialised JSON fails, which is why the raw bytes must be used', () => {
  const headers = sign(BODY);
  // Same data, different formatting -- exactly what a body parser would hand us.
  const reserialised = JSON.stringify(JSON.parse(BODY), null, 2);
  assert.throws(() => verifyWebhook(Buffer.from(reserialised), headers), /signature mismatch/);
});

test('a signature made with the wrong key is rejected', () => {
  const headers = sign(BODY, { key: Buffer.from('a-different-key') });
  assert.throws(() => verifyWebhook(Buffer.from(BODY), headers), /signature mismatch/);
});

test('an old delivery is rejected, bounding replay', () => {
  const stale = Math.floor(Date.now() / 1000) - 601;
  assert.throws(() => verifyWebhook(Buffer.from(BODY), sign(BODY, { timestamp: stale })), /tolerance/);
});

test('a future-dated delivery is rejected too', () => {
  const ahead = Math.floor(Date.now() / 1000) + 601;
  assert.throws(() => verifyWebhook(Buffer.from(BODY), sign(BODY, { timestamp: ahead })), /tolerance/);
});

test('missing signature headers are rejected rather than skipped', () => {
  const complete = sign(BODY);
  for (const omit of ['webhook-id', 'webhook-timestamp', 'webhook-signature']) {
    const headers: Record<string, string> = { ...complete };
    delete headers[omit];
    assert.throws(() => verifyWebhook(Buffer.from(BODY), headers), /Missing webhook signature headers/);
  }
});

test('the id used for idempotency comes from the header, not the body', () => {
  // A forged body cannot claim someone else's delivery id to poison the
  // replay table, because we only ever trust the signed header value.
  const body = JSON.stringify({ id: 'attacker-chosen', type: 'order.paid', data: {} });
  const event = verifyWebhook(Buffer.from(body), sign(body, { id: 'msg_real' }));
  assert.equal(event.id, 'msg_real');
});

test('several offered signatures verify if any one matches, for key rotation', () => {
  const headers = sign(BODY);
  headers['webhook-signature'] = `v1,AAAA ${headers['webhook-signature']}`;
  assert.equal(verifyWebhook(Buffer.from(BODY), headers).type, 'order.paid');
});
