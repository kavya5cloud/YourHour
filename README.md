# GetYourHour

A single-spot hourly billboard. Each hour, one paying owner gets the homepage.
Fifty percent of net proceeds goes to charity.

## How it works

1. The board shows the next 24 hours, each with a price. **An hour costs more
   the sooner it is** -- $50 for the next hour, $25 two out, down to a $5 floor
   about ten hours out. Paying more buys a sooner slot.
2. You pick an hour, fill in your product, link, and an optional logo, and go
   straight to a Polar checkout. The hour is held for you while you pay.
3. The moment payment clears, that hour is yours. Your name, line, logo, and
   link occupy the homepage for its full sixty minutes.
4. If you abandon checkout, the hold lapses and the hour goes back on sale.

There is no bidding, so nobody is ever outbid, displaced, or refunded. That is
deliberate: because a buyer learns their hour at the moment they pay, on Polar's
own confirmation page, nothing ever has to be emailed to them afterwards.

Every one of those decisions is made server-side against the database clock.
The browser only displays the result.

## Layout

```
src-api/                handler sources; `npm run build` bundles these into api/
  state.ts              public state: current owner, and the board of hours
  claim.ts              buy one hour, and open its Polar checkout
  moderation.ts         review listing text before it is displayed
  auth/                 passwordless sign-in, session, sign-out
  webhooks/polar.ts     the only path that may mark an hour paid
  cron/rollover.ts      marks unbought hours unsold; optional (see below)
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
npm run dev                    # local server on :3000
```

Generate the two secrets with `openssl rand -base64 48`. The app refuses to
start if either is missing or under 32 characters — see
[SECURITY.md](SECURITY.md) for why nothing has a default.

## Deploying

Built for Vercel: `public/` is served statically, `api/` becomes serverless
functions, and [vercel.json](vercel.json) carries the security headers.

`api/` is **generated**. Every module imports with an explicit `.ts` extension,
which is what Node's type stripping needs to run the sources directly in tests
and in `npm run dev`. Vercel compiles the entry point but leaves those
specifiers alone, so a deployed function tries to import `lib/http.ts` at
runtime and dies with `ERR_MODULE_NOT_FOUND`. `npm run build` bundles each
handler in `src-api/` into one self-contained file in `api/`, leaving no
relative import for the platform to resolve. Edit `src-api/`, never `api/`.

1. Set every variable from `.env.example` in the project's environment settings.
2. `POLAR_WEBHOOK_SECRET` must match the endpoint you register with Polar,
   pointed at `https://<your-domain>/api/webhooks/polar`.
3. Rollover is **optional**, and there is no scheduler configured.

   Abandoned reservations free themselves: the board ignores an expired hold,
   and `claimHour` clears an hour's own stale hold under the row lock before
   inserting. An hour returns to sale the moment its hold lapses, whether or
   not anything is scheduled.

   `/api/cron/rollover` only labels past unbought hours "unsold", which is
   cosmetic. If you want that tidy, call it on a schedule with
   `Authorization: Bearer $CRON_SECRET` -- on Vercel Pro via a `crons` entry in
   `vercel.json`. Hobby plans cap cron at once per day and reject anything more
   frequent, which fails the whole deployment, so nothing is wired up here.

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
npm test                                    # 32 unit tests, no database needed
TEST_DATABASE_URL=postgres://... npm test   # all 54, including integration
```

Three layers:

- **Unit** — input normalisation and rejection, the proceeds split, hour
  arithmetic, and webhook signature verification (tampered bodies, replayed
  timestamps, wrong keys, and the re-serialisation case that makes raw-body
  handling necessary). No database.
- **Integration** — claiming, the double-sell guarantee under concurrency,
  price-by-distance, abandoned reservations returning to the board, and
  duplicate payment confirmation, against real Postgres.
- **API** — handlers mounted on a real `http.Server`: security headers, 405s,
  claiming without a session, the required link, a taken hour returning 409,
  CSRF enforcement, account-enumeration resistance, and the cron secret check.

The DB-backed suites truncate shared tables, so the test script pins
`--test-concurrency=1`. Do not remove that without giving each suite its own
database.

### The double-sell guarantee

Two buyers can reach `claimHour` for the same hour at the same instant. What
stops them both succeeding is not application logic but a partial unique index:

```sql
CREATE UNIQUE INDEX bids_one_live_claim_idx
  ON bids (hour_id) WHERE status IN ('active', 'won');
```

The loser's INSERT violates it and is turned into a 409. Drop that index and
`concurrent claims on one hour cannot both succeed` fails, which is the point:
the database decides, not a read-then-write that a race could interleave.
