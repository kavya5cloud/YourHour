/**
 * End-to-end tests of the HTTP handlers.
 *
 * The handlers are plain Node request/response functions, so they can be
 * mounted on a real `http.Server` and driven with real `fetch`. That exercises
 * the whole path -- routing, header emission, body reading, origin and CSRF
 * checks, error shaping -- rather than calling the inner logic directly.
 *
 * Skipped unless TEST_DATABASE_URL is set.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { loadEnv } from './setup.ts';

const databaseUrl = process.env.TEST_DATABASE_URL;

if (!databaseUrl) {
  test('api tests (skipped: set TEST_DATABASE_URL to run)', { skip: true }, () => {});
} else {
  loadEnv();
  process.env.DATABASE_URL = databaseUrl;

  const emails: Array<{ to: string; body: string }> = [];
  let checkouts = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/v1/checkouts')) {
      checkouts += 1;
      return new Response(
        JSON.stringify({ id: `chk_${checkouts}`, url: `https://checkout.polar.sh/chk_${checkouts}` }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    // The favicon lookup is best-effort; refusing it exercises the null path.
    if (url.includes('google.com/s2/favicons')) {
      return new Response('nope', { status: 404 });
    }
    if (url.includes('resend.com')) {
      const parsed = JSON.parse(String(init?.body ?? '{}'));
      emails.push({ to: parsed.to?.[0] ?? '', body: parsed.text ?? '' });
      return new Response('{}', { status: 200 });
    }
    throw new Error(`unexpected outbound request: ${url}`);
  }) as typeof fetch;

  const { query } = await import('../lib/db.ts');
  const auctionModule = await import('../lib/auction.ts');
  const stateHandler = (await import('../api/state.ts')).default;
  const claimHandler = (await import('../api/claim.ts')).default;
  const meHandler = (await import('../api/auth/me.ts')).default;
  const requestLinkHandler = (await import('../api/auth/request-link.ts')).default;
  const cronHandler = (await import('../api/cron/rollover.ts')).default;
  const { createSession, csrfTokenFor, SESSION_COOKIE } = await import('../lib/session.ts');

  const ORIGIN = 'https://getyourhour.test';

  /** The soonest claimable hour. */
  const nextHourId = (): number => auctionModule.hourIdAt(Date.now()) + 1;

  /** Mount one handler on a throwaway server and return its base URL. */
  async function serve(handler: (req: never, res: never) => Promise<void>): Promise<{ url: string; server: Server }> {
    const server = createServer((req, res) => {
      void handler(req as never, res as never);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${port}`, server };
  }

  /** Node's global fetch is stubbed above, so talk to the test server directly. */
  const { request } = await import('node:http');
  function call(
    url: string,
    options: { method?: string; headers?: Record<string, string>; body?: string } = {},
  ): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string }> {
    return new Promise((resolve, reject) => {
      const target = new URL(url);
      const req = request(
        {
          hostname: target.hostname,
          port: target.port,
          path: target.pathname + target.search,
          method: options.method ?? 'GET',
          headers: options.headers ?? {},
        },
        (res) => {
          let text = '';
          res.on('data', (chunk) => (text += chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
        },
      );
      req.on('error', reject);
      if (options.body !== undefined) req.write(options.body);
      req.end();
    });
  }

  async function reset(): Promise<void> {
    await query(
      `TRUNCATE payments, bids, hours, sessions, login_tokens, users,
                webhook_events, rate_limits, audit_log RESTART IDENTITY CASCADE`,
    );
  }

  test('GET /api/state returns public data with security headers', async () => {
    await reset();
    const { url, server } = await serve(stateHandler);
    try {
      const response = await call(`${url}/api/state`);
      assert.equal(response.status, 200);

      const body = JSON.parse(response.text);
      assert.ok(body.serverTime, 'serverTime drives the client countdown');
      assert.ok(body.currentHour && body.nextHour, 'shape matches PublicState');

      assert.equal(response.headers['x-content-type-options'], 'nosniff');
      assert.equal(response.headers['x-frame-options'], 'DENY');
      assert.equal(response.headers['referrer-policy'], 'strict-origin-when-cross-origin');

      // The public payload must not leak bidder identity.
      assert.ok(!response.text.includes('@'), 'no email addresses in public state');
      assert.ok(!/user_id|userId/.test(response.text), 'no user ids in public state');
    } finally {
      server.close();
    }
  });

  test('a non-GET method on /api/state is rejected with 405', async () => {
    const { url, server } = await serve(stateHandler);
    try {
      const response = await call(`${url}/api/state`, { method: 'DELETE' });
      assert.equal(response.status, 405);
      assert.equal(response.headers['allow'], 'GET');
    } finally {
      server.close();
    }
  });

  test('a first-time buyer can claim without signing in first', async () => {
    await reset();
    const { url, server } = await serve(claimHandler);
    try {
      const response = await call(`${url}/api/claim`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({
          hourId: nextHourId(),
          name: 'example.com',
          link: 'example.com',
          email: 'new@example.test',
        }),
      });
      assert.equal(response.status, 201, 'no sign-in gate on claiming');
      const body = JSON.parse(response.text);
      assert.equal(body.priceCents, 5000, 'the next hour is priced at the base');
      assert.ok(body.checkoutUrl.startsWith('https://'), 'a checkout URL comes back');
    } finally {
      server.close();
    }
  });

  test('a claim with no email and no session is rejected', async () => {
    await reset();
    const { url, server } = await serve(claimHandler);
    try {
      const response = await call(`${url}/api/claim`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ hourId: nextHourId(), name: 'example.com', link: 'example.com' }),
      });
      assert.equal(response.status, 400);
      assert.match(JSON.parse(response.text).message, /email/i);
    } finally {
      server.close();
    }
  });

  test('a claim without a link is rejected', async () => {
    await reset();
    const { url, server } = await serve(claimHandler);
    try {
      const response = await call(`${url}/api/claim`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({
          hourId: nextHourId(),
          name: 'example.com',
          email: 'nolink@example.test',
        }),
      });
      assert.equal(response.status, 400);
      assert.equal(JSON.parse(response.text).error, 'link_required');
    } finally {
      server.close();
    }
  });

  test('claiming an hour that is already taken is a clean conflict', async () => {
    await reset();
    const { url, server } = await serve(claimHandler);
    try {
      const hourId = nextHourId();
      const body = (email: string): string =>
        JSON.stringify({ hourId, name: 'example.com', link: 'example.com', email });

      const first = await call(`${url}/api/claim`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: body('one@example.test'),
      });
      assert.equal(first.status, 201);

      const second = await call(`${url}/api/claim`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: body('two@example.test'),
      });
      assert.equal(second.status, 409, 'the hour is not sold twice');
      assert.equal(JSON.parse(second.text).error, 'hour_taken');
    } finally {
      server.close();
    }
  });

  test('POST /api/claim from a foreign origin is refused before auth', async () => {
    await reset();
    const { url, server } = await serve(claimHandler);
    try {
      const response = await call(`${url}/api/claim`, {
        method: 'POST',
        headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
        body: JSON.stringify({ hourId: nextHourId(), name: 'example.com', link: 'example.com' }),
      });
      assert.equal(response.status, 403);
      assert.match(JSON.parse(response.text).message, /Cross-origin/);
    } finally {
      server.close();
    }
  });


  test('an unauthenticated caller gets signedIn:false and no CSRF token', async () => {
    await reset();
    const { url, server } = await serve(meHandler);
    try {
      const response = await call(`${url}/api/auth/me`);
      assert.equal(response.status, 200);
      const body = JSON.parse(response.text);
      assert.equal(body.signedIn, false);
      assert.equal(body.csrfToken, undefined, 'no CSRF token is issued without a session');
    } finally {
      server.close();
    }
  });

  test('sign-in link requests do not reveal whether an account exists', async () => {
    await reset();
    await query(`INSERT INTO users (email) VALUES ('known@example.test')`);

    const { url, server } = await serve(requestLinkHandler);
    try {
      const known = await call(`${url}/api/auth/request-link`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'known@example.test' }),
      });
      const unknown = await call(`${url}/api/auth/request-link`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'nobody@example.test' }),
      });

      assert.equal(known.status, unknown.status, 'status must not differ');
      assert.equal(known.text, unknown.text, 'body must be byte-identical');
    } finally {
      server.close();
    }
  });

  test('the cron endpoint refuses a missing or wrong secret', async () => {
    const { url, server } = await serve(cronHandler);
    try {
      const none = await call(`${url}/api/cron/rollover`);
      assert.equal(none.status, 401);

      const wrong = await call(`${url}/api/cron/rollover`, {
        headers: { authorization: 'Bearer not-the-real-secret-value-at-all' },
      });
      assert.equal(wrong.status, 401);

      const right = await call(`${url}/api/cron/rollover`, {
        headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
      });
      assert.equal(right.status, 200, 'the correct secret is accepted');
      assert.equal(JSON.parse(right.text).ok, true);
    } finally {
      server.close();
    }
  });

  test('a malformed JSON body is rejected without leaking internals', async () => {
    await reset();
    const { url, server } = await serve(claimHandler);
    try {
      const response = await call(`${url}/api/claim`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: '{not json',
      });
      // Auth runs before body parsing, so this is a 401; either way, no stack.
      assert.ok(response.status >= 400);
      assert.ok(!/at \w+ \(/.test(response.text), 'no stack trace in the response');
      assert.ok(!response.text.includes('postgres://'), 'no connection string in the response');
    } finally {
      server.close();
    }
  });

  test.after(async () => {
    await globalThis.__getYourHourPool?.end();
  });
}
