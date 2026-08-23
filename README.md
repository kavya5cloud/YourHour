# GetYourHour

A single-spot hourly billboard. Each hour, one paying owner gets the homepage.
Fifty percent of net proceeds goes to charity.

## How it works

1. You pay whatever you think an hour is worth. There is no fixed price and no
   slot to choose.
2. Everyone who has paid is ranked by amount, highest first, ties broken by who
   paid earlier. That ranking is the running order.
3. When an hour comes round it takes whoever is at the front, and **keeps
   them**. An hour already on air can never be bought out from under its owner.
4. Paying more moves you up the order. It never decides whether you get on at
   all -- everyone who pays airs eventually.

Nobody is ever outbid into getting nothing, so no buyer is ever left needing to
be told to act. That is what lets the whole flow run without sending a single
email: your slot may drift later if someone pays more, but it is never lost.

Every one of those decisions is made server-side against the database clock.
The browser only displays the result.

## Layout

```
src-api/                handler sources; `npm run build` bundles these into api/
  state.ts              public state: who is on air, and the running order
  claim.ts              buy a slot, and open its Polar checkout
  health.ts             which env vars are set; temporary, delete when healthy
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
relative import for the platform to resolve.

`api/` is committed even though it is generated. Vercel discovers functions
from the uploaded repository rather than from build output, so an `api/` that
only exists after the build command runs is never turned into functions at all
-- the routes 404. **Run `npm run build` and commit `api/` whenever you change
anything under `src-api/` or `lib/`,** or the deployment will keep serving the
previous bundle. Edit `src-api/`, never `api/`.

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

The DB-backed suites truncate shared tables **and** `/api/state` now writes --
it assigns an hour its occupant on read -- so the two of them cannot run at
the same time: whichever polls state will consume the queue the other is
asserting on. `--test-concurrency=1` did not reliably serialise separate
files, so the test script runs them as three sequential `node --test`
invocations instead. Do not collapse them back into one without giving each
suite its own database.

### What the tests pin down

The guarantee that matters is that **an hour on air keeps its owner**. Ranking
is provisional for every hour still ahead -- a bigger payer reorders them
freely -- but the moment an hour starts it takes the front of the pool and
holds it. `an hour that has started cannot be bumped by a bigger payer` is the
test for exactly that.

Assignment happens lazily inside `getPublicState`, under the hour's row lock
and with `FOR UPDATE SKIP LOCKED` on the pool, so concurrent readers cannot
hand the same slot to two buyers and no scheduler has to be running for the
page to be correct.
