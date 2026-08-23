# The Hour

A single-spot hourly auction. The current owner gets the homepage for an hour;
the next hour is open for bids. Fifty percent of net proceeds from paid winning
hours goes to charity.

## How it works

1. Bids are placed on the **next** hour. No payment method is taken at bid time,
   and no sign-in is required — the bid form is the whole signup. Bidders who
   have not confirmed their email are capped at `MAX_UNVERIFIED_BID_CENTS`.
2. When the hour rolls over, the highest bidder is emailed a Polar checkout link.
3. They have five minutes to pay. If they do not, the hour passes to the next
   bidder, and so on until someone pays or the hour runs out.
4. A paid winner's name and one-line message occupy the homepage for their hour.

Every one of those decisions is made server-side against the database clock.
The browser only displays the result.

## Layout

```
api/
  state.ts              public auction state (unauthenticated)
  bids.ts               place a bid
  moderation.ts         review listing text before it is displayed
  auth/                 passwordless sign-in, session, sign-out
  webhooks/polar.ts     the only path that may mark an hour paid
  cron/rollover.ts      closes hours, opens and expires payment windows
lib/                    env, db, crypto, http, session, rate limiting,
                        validation, auction logic, Polar, email, audit
db/schema.sql           tables, enums, constraints, indexes
public/                 the page: index.html, app.css, app.js
test/                   validation, money split, webhook verification
```

## Running it

```bash
npm install
cp .env.example .env.local     # then fill in every value
npm run migrate                # applies db/schema.sql (idempotent)
npm run check                  # typecheck + tests
npx vercel dev
```

Generate the two secrets with `openssl rand -base64 48`. The app refuses to
start if either is missing or under 32 characters — see
[SECURITY.md](SECURITY.md) for why nothing has a default.

## Deploying

Built for Vercel: `public/` is served statically, `api/` becomes serverless
functions, and [vercel.json](vercel.json) carries the security headers.

1. Set every variable from `.env.example` in the project's environment settings.
2. `POLAR_WEBHOOK_SECRET` must match the endpoint you register with Polar,
   pointed at `https://<your-domain>/api/webhooks/polar`.
3. Rollover is driven by [.github/workflows/rollover.yml](.github/workflows/rollover.yml),
   which calls `/api/cron/rollover` every five minutes. Set `SITE_ORIGIN` and
   `CRON_SECRET` as **repository secrets** for it to work.

   It is not in `vercel.json`, deliberately: Hobby plans cap cron at once per
   day and reject a more frequent schedule, which fails the whole deployment.
   On Pro, prefer Vercel Cron — it is punctual, where GitHub's scheduler has a
   five-minute floor and is often ten or more minutes late. Add this to
   `vercel.json` and delete the workflow:

   ```json
   "crons": [{ "path": "/api/cron/rollover", "schedule": "* * * * *" }]
   ```

   Vercel then sends `Authorization: Bearer $CRON_SECRET` automatically.
   Note that `vercel.json` is strict JSON with no unknown keys permitted —
   a stray `"comment"` field will fail the build.
4. Run `npm run migrate` against the production database once.

Hosting elsewhere: the handlers are plain Node request/response functions, but
the header configuration in `vercel.json` would need translating to
that platform (a `_headers` file on Netlify, a server block on nginx/Caddy).

## Security

The threat model, the concurrency and payment-integrity arguments, and the
known limitations are documented in [SECURITY.md](SECURITY.md). Worth reading
before changing anything in `lib/auction.ts` or the webhook route.

## Testing

```bash
npm test                                    # 27 unit tests, no database needed
TEST_DATABASE_URL=postgres://... npm test   # all 53, including integration
```

Three layers:

- **Unit** — input normalisation and rejection, the proceeds split, hour
  arithmetic, and webhook signature verification (tampered bodies, replayed
  timestamps, wrong keys, and the re-serialisation case that makes raw-body
  handling necessary). No database.
- **Integration** — bidding, the row-lock concurrency guarantee, rollover
  idempotency, payment-window expiry and promotion, and duplicate payment
  confirmation, against real Postgres.
- **API** — handlers mounted on a real `http.Server`: security headers, 405s,
  the unverified bid cap, CSRF enforcement on session-bearing requests,
  account-enumeration resistance, and the cron secret check.

The DB-backed suites truncate shared tables, so the test script pins
`--test-concurrency=1`. Do not remove that without giving each suite its own
database.

### Verifying the concurrency test still has teeth

The row lock in `lib/auction.ts` is load-bearing. To confirm the test would
actually catch its removal:

```bash
sed -i '' 's/WHERE id = $1 FOR UPDATE/WHERE id = $1/' lib/auction.ts
TEST_DATABASE_URL=postgres://... node --test --test-name-pattern="concurrent bids" test/integration.test.ts
# expect: FAIL -- "exactly one bid should win, got 3"
git checkout lib/auction.ts
```

This check matters because the first version of that test passed *with the lock
removed*: the hour row did not exist yet, so `INSERT ... ON CONFLICT` serialised
the transactions on the unique index and hid the race. The test now commits the
hour row first, matching production, where the cron job has already created it.
