# Security

The Hour takes money from strangers, publishes text they wrote onto its own
homepage, and does both on a one-hour cycle with no human in the loop. This
document records what that means for the threat model, what the code does about
it, and what is deliberately still open.

## Trust boundaries

There are four places untrusted data enters the system.

| Boundary | What arrives | Where it is handled |
| --- | --- | --- |
| Browser to API | bid amounts, listing text, email addresses | [lib/validate.ts](lib/validate.ts) |
| Polar to webhook | payment outcomes | [lib/polar.ts](lib/polar.ts) |
| Scheduler to cron route | "close the hour now" | [api/cron/rollover.ts](api/cron/rollover.ts) |
| Database to browser | stored listing text | [public/app.js](public/app.js) |

Everything else is internal. The browser is never inside a trust boundary: it
does not decide who leads, what an hour costs, when an hour ends, or whether
anyone has paid.

## The properties that have to hold

### 1. Two bidders cannot both win

Every mutation of auction state takes `SELECT ... FOR UPDATE` on the hour row as
its first statement, inside a transaction ([lib/auction.ts](lib/auction.ts)).
The required price is then recomputed *under that lock* from stored bids. A
client that submits a stale or forged "current price" changes nothing, and two
simultaneous bids of the same amount serialise, so exactly one takes the lead.

The naive version of this — read the high bid, compare in application code,
then insert — is the classic auction race, and it is what the lock exists to
prevent.

This is verified, not asserted. `test/integration.test.ts` fires five identical
bids simultaneously and requires exactly one to succeed. The test has been
mutation-checked: with `FOR UPDATE` removed, three bidders all win at the same
price and the test fails. See the README for how to re-run that check.

One caveat worth knowing if you edit those tests: the concurrency test commits
the hour row *before* bidding. Without that setup, concurrent `placeBid` calls
all race to `INSERT ... ON CONFLICT DO NOTHING` the same hour, Postgres
serialises them on the unique index, and the race is masked — the test then
passes even with the lock removed.

### 2. Only a verified webhook can mark an hour paid

Returning to the success URL in a browser proves nothing; anyone can navigate
there. `markPaid` is reachable only from
[api/webhooks/polar.ts](api/webhooks/polar.ts), which requires:

- all three Standard Webhooks headers present,
- a timestamp within ±5 minutes, bounding replay of a captured request,
- an HMAC-SHA256 over `id.timestamp.rawBody` matching in **constant time**.

Body parsing is disabled on that route so the signature covers the exact bytes
sent. If the raw body cannot be read, the request is rejected rather than
processed unverified — it fails closed.

Replay is stopped by the database, not by application logic: the delivery id is
inserted into `webhook_events` under a primary key, so two concurrent
deliveries of the same event cannot both proceed.

### 3. Money arithmetic is exact

All amounts are integer cents. Bids are accepted only as whole dollars, which
keeps floating point out of the money path entirely. The charity share is
floored, so a sub-cent remainder is never promised and then not paid.

### 4. User text cannot become script

Defence in depth, three independent layers:

1. **Input** — [lib/validate.ts](lib/validate.ts) normalises to NFC, strips
   control codes, zero-width characters, and bidi overrides (the trick that
   makes `moc.elpmaxe` render as `example.com`), collapses whitespace, and caps
   length.
2. **Output** — [public/app.js](public/app.js) writes user data only via
   `textContent` and created elements. There is no `innerHTML` in the codebase.
   A listing containing `<img onerror=...>` is displayed as those literal
   characters.
3. **Policy** — the CSP in [vercel.json](vercel.json) is
   `default-src 'none'` with `script-src 'self'` and **no** `unsafe-inline`.
   The page carries no inline script or style, so nothing had to be relaxed to
   make it work — which is what makes the policy real rather than decorative.

Listings additionally default to `moderation = 'pending'` and render as
"Listing under review" until approved via [api/moderation.ts](api/moderation.ts).

## Authentication

Passwordless, because the safest password database is the one that does not
exist.

- Sign-in tokens: 256-bit CSPRNG, single-use, 15-minute expiry, stored only as
  an HMAC. Requesting a new link invalidates outstanding ones. Consumption is a
  conditional `UPDATE`, so two simultaneous clicks cannot both mint a session.
- Sessions: opaque 256-bit token in an `HttpOnly`, `Secure`, `SameSite=Lax`,
  `__Host-`-prefixed cookie. Only the HMAC is stored, so a database leak yields
  no usable cookies. Every request re-checks the row, so logout and account
  disable take effect immediately.
- CSRF: a token derived from the session id under `SECRET_KEY`, returned in the
  JSON body of `/api/auth/me` and required in the `x-csrf-token` header.
  Delivered in a body rather than a readable cookie because a cross-origin page
  cannot read our responses. Paired with a strict `Origin`/`Referer` check on
  every state-changing route.
- No account enumeration: `/api/auth/request-link` returns a byte-identical
  response whether the address exists, is disabled, was rate limited, or failed
  to send.
- The verify route redirects to a **constant** path. It accepts no `next`
  parameter — that is how magic-link endpoints become open redirects, and an
  open redirect on a login path is a working phishing primitive.

## Abuse and rate limiting

Counters live in Postgres ([lib/ratelimit.ts](lib/ratelimit.ts)) as a single
atomic upsert. In-memory limiting would be useless here: serverless invocations
are independent, so the counter would reset on every cold start and could be
bypassed by fanning requests across instances.

Client IP is read from `x-vercel-forwarded-for` / `x-real-ip` — platform-set
headers — and deliberately **not** from raw `x-forwarded-for`, which a client
can prepend to in order to forge a fresh identity per request.

IPs are stored only as keyed hashes. Rotating `SECRET_KEY` re-anonymises them.

## Data handling

`/api/state` is public and deliberately thin: current owner, standing lead,
recent winners, totals. No emails, no user ids, no bid ids, no losing bidders.
A public auction feed should not double as a directory of who is bidding what.

Error responses never carry internal detail. Unexpected failures return a
correlation id; the stack trace goes to the server log only.

## Known limitations

Stated plainly, because an undocumented gap is worse than an accepted one.

- **Sniping is possible and is not mitigated.** Hours have hard clock
  boundaries, so a bid placed in the final second wins. Anti-snipe extension
  would break the premise that an hour is an hour. Accepted by design.
- **Rate limit windows are fixed, not sliding.** A burst can straddle a
  boundary and briefly deliver up to 2× the limit. Acceptable for abuse
  control; it is not a correctness control.
- **The rollover transaction calls Polar while holding the hour's row lock.**
  Bounded by `lock_timeout` and `idle_in_transaction_session_timeout` in
  [lib/db.ts](lib/db.ts). Contention is low in practice — bids target hour N+1
  while rollover works on hour N — but this is the piece to revisit first if
  the auction gets busy.
- **Fee figures are an estimate.** `FEE_BASIS_POINTS` / `FEE_FIXED_CENTS`
  approximate provider fees for the charity calculation. Reconcile against
  actual settlement before publishing donation totals as fact.
- **`LISTING_AUTO_APPROVE=true` puts unreviewed text on the homepage.** The
  XSS layers still apply, but impersonation and abusive content would not be
  caught before display. Leave it off unless someone is watching the queue.
- **No admin UI.** Moderation is an API with an allowlist of user ids in
  environment configuration. There is no self-service path to becoming a
  moderator, which is intentional.

## Operational requirements

- `SECRET_KEY` and `CRON_SECRET` must each be 32+ characters of real entropy
  (`openssl rand -base64 48`). The app refuses to start otherwise. Nothing has
  a default value — a default secret is a published secret.
- `SITE_ORIGIN` must be https in production; startup fails if it is not.
- Point `DATABASE_URL` at a **pooled** endpoint. Serverless opens many
  short-lived connections and will exhaust a direct endpoint's limit.
- Rotating `SECRET_KEY` invalidates all sessions and sign-in links, and
  re-anonymises IP hashes. That is the intended behaviour after a suspected
  compromise.

## Reporting

Report suspected vulnerabilities privately to the address in the repository
metadata rather than opening a public issue.
