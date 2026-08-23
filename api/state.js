// lib/http.ts
import { randomUUID } from "node:crypto";

// lib/env.ts
function required(name, minLength = 1) {
  const value = process.env[name];
  if (value === void 0 || value === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  if (value.length < minLength) {
    throw new Error(`Environment variable ${name} is too short (need >= ${minLength} chars)`);
  }
  return value;
}
function optional(name) {
  const value = process.env[name];
  return value === void 0 || value === "" ? void 0 : value;
}
function integer(name, fallback) {
  const raw = optional(name);
  if (raw === void 0) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed)) throw new Error(`Environment variable ${name} must be an integer`);
  return parsed;
}
var SECRET_MIN = 32;
var env = {
  nodeEnv: optional("NODE_ENV") ?? "development",
  isProduction: (optional("VERCEL_ENV") ?? optional("NODE_ENV")) === "production",
  /** Canonical public origin, e.g. https://getyourhour.example. Used for cookies,
   *  links in email, and strict Origin checking on state-changing requests. */
  siteOrigin: required("SITE_ORIGIN"),
  databaseUrl: required("DATABASE_URL"),
  /** Key for hashing session/login tokens and IPs. Rotating it logs everyone
   *  out and re-anonymises IP hashes, which is the intended behaviour. */
  secretKey: required("SECRET_KEY", SECRET_MIN),
  /** Shared secret for the scheduled rollover endpoint. */
  cronSecret: required("CRON_SECRET", SECRET_MIN),
  polar: {
    accessToken: required("POLAR_ACCESS_TOKEN"),
    webhookSecret: required("POLAR_WEBHOOK_SECRET"),
    productId: required("POLAR_PRODUCT_ID"),
    apiBase: optional("POLAR_API_BASE") ?? "https://api.polar.sh"
  },
  email: {
    apiKey: required("RESEND_API_KEY"),
    from: required("EMAIL_FROM")
  },
  /** Comma-separated user ids allowed to reach moderation endpoints. */
  moderatorIds: (optional("MODERATOR_USER_IDS") ?? "").split(",").map((id) => id.trim()).filter(Boolean),
  auction: {
    /** Minimum opening bid and minimum raise over the standing bid, in cents. */
    minBidCents: integer("MIN_BID_CENTS", 100),
    minIncrementCents: integer("MIN_INCREMENT_CENTS", 100),
    /** Upper bound on a single bid, a guard against fat-finger and abuse. */
    maxBidCents: integer("MAX_BID_CENTS", 1e7),
    /**
     * Ceiling for a bidder who has not yet proved they own their email address.
     *
     * Bidding is open to anyone with an email box, which is what keeps the
     * hourly cadence usable. The cost is that an unverified stranger could
     * otherwise park an enormous bid on an hour and simply never pay, denying
     * it to real bidders. Capping unverified bids bounds the damage of that to
     * something small, while leaving casual bidding frictionless.
     */
    maxUnverifiedBidCents: integer("MAX_UNVERIFIED_BID_CENTS", 5e3),
    /**
     * Claim pricing. An hour's price falls the further out it is, so paying
     * more buys a sooner slot without anyone ever being displaced:
     *   price(hoursAway) = max(floor, round(base / hoursAway))
     * With the defaults that is $50 for the next hour, $25 two out, $10 five
     * out, and $5 for anything ten hours or further away.
     */
    claimBaseCents: integer("CLAIM_BASE_CENTS", 5e3),
    claimFloorCents: integer("CLAIM_FLOOR_CENTS", 500),
    /** How far ahead the board is open for claiming. */
    claimHorizonHours: integer("CLAIM_HORIZON_HOURS", 24),
    /** How long a slot is held while the buyer is inside Polar checkout. */
    reservationSeconds: integer("RESERVATION_SECONDS", 600),
    /** How long a winner has to complete checkout. */
    paymentWindowSeconds: integer("PAYMENT_WINDOW_SECONDS", 300),
    /** Share of net proceeds pledged to charity, in basis points. */
    charityBasisPoints: integer("CHARITY_BASIS_POINTS", 5e3),
    /** Provider fee estimate used to compute net, in basis points + fixed. */
    feeBasisPoints: integer("FEE_BASIS_POINTS", 290),
    feeFixedCents: integer("FEE_FIXED_CENTS", 30),
    /**
     * When false, a winning listing shows a neutral placeholder until a
     * moderator approves it. Turning this on trades human review for
     * immediacy, and puts unreviewed user text on the homepage.
     */
    autoApproveListings: (optional("LISTING_AUTO_APPROVE") ?? "false") === "true"
  },
  limits: {
    /** Bids allowed per user and per IP inside a rolling window. */
    bidsPerUserPerHour: integer("RATE_BIDS_PER_USER", 30),
    bidsPerIpPerHour: integer("RATE_BIDS_PER_IP", 60),
    loginLinksPerEmail: integer("RATE_LOGIN_PER_EMAIL", 5),
    loginLinksPerIp: integer("RATE_LOGIN_PER_IP", 20)
  }
};
var siteUrl = new URL(env.siteOrigin);
if (env.isProduction && siteUrl.protocol !== "https:") {
  throw new Error("SITE_ORIGIN must use https in production");
}

// lib/http.ts
var MAX_BODY_BYTES = 16 * 1024;
var HttpError = class extends Error {
  // Declared as plain fields rather than constructor parameter properties:
  // Node's type-stripping runtime does not support the latter.
  status;
  code;
  headers;
  constructor(status, message, code = "error", headers = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
};
function applySecurityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "geolocation=(), camera=(), microphone=(), payment=(), usb=()");
  res.setHeader("Cache-Control", "no-store, private");
  if (env.isProduction) {
    res.setHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  }
}
function sendJson(res, status, body, headers = {}) {
  applySecurityHeaders(res);
  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.statusCode = status;
  res.end(JSON.stringify(body));
}
function requireMethod(req, ...allowed) {
  if (!allowed.includes(req.method ?? "")) {
    throw new HttpError(405, "Method not allowed.", "method_not_allowed", { Allow: allowed.join(", ") });
  }
}
function withErrorHandling(handler2) {
  return async (req, res) => {
    try {
      await handler2(req, res);
    } catch (error) {
      if (error instanceof HttpError) {
        sendJson(res, error.status, { error: error.code, message: error.message }, error.headers);
        return;
      }
      const incidentId = randomUUID();
      console.error("unhandled error", {
        incidentId,
        path: req.url,
        method: req.method,
        message: error?.message,
        stack: error?.stack
      });
      sendJson(res, 500, {
        error: "internal_error",
        message: "Something went wrong on our end.",
        incidentId
      });
    }
  };
}

// lib/db.ts
import pg from "pg";
var { Pool } = pg;
pg.types.setTypeParser(20, (value) => Number.parseInt(value, 10));
function getPool() {
  if (!globalThis.__getYourHourPool) {
    globalThis.__getYourHourPool = new Pool({
      connectionString: env.databaseUrl,
      max: 3,
      idleTimeoutMillis: 1e4,
      connectionTimeoutMillis: 5e3,
      // Refuse to fall back to an unencrypted connection in production.
      ssl: env.isProduction ? { rejectUnauthorized: true } : void 0,
      // A stuck statement must not pin a serverless invocation open.
      statement_timeout: 8e3,
      query_timeout: 8e3
    });
    globalThis.__getYourHourPool.on("error", (error) => {
      console.error("pg pool error", { message: error.message });
    });
  }
  return globalThis.__getYourHourPool;
}
async function query(text, params = []) {
  return getPool().query(text, params);
}
async function tx(fn) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL lock_timeout = '5s'`);
    await client.query(`SET LOCAL idle_in_transaction_session_timeout = '15s'`);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      console.error("rollback failed", { message: rollbackError.message });
    }
    throw error;
  } finally {
    client.release();
  }
}

// lib/auction.ts
var HOUR_MS = 36e5;
var EPOCH_MS = Date.UTC(2024, 0, 1, 0, 0, 0);
function hourIdAt(instant = Date.now()) {
  const ms = instant instanceof Date ? instant.getTime() : instant;
  return Math.floor((ms - EPOCH_MS) / HOUR_MS) + 1;
}
function hourStartsAt(hourId) {
  return new Date(EPOCH_MS + (hourId - 1) * HOUR_MS);
}
var UNDER_REVIEW = "Listing under review";
function splitProceeds(amountCents) {
  const feeCents = Math.min(
    amountCents,
    Math.round(amountCents * env.auction.feeBasisPoints / 1e4) + env.auction.feeFixedCents
  );
  const netCents = Math.max(0, amountCents - feeCents);
  const charityCents = Math.floor(netCents * env.auction.charityBasisPoints / 1e4);
  return { amountCents, feeCents, netCents, charityCents };
}
async function ensureHour(client, hourId) {
  const runner = client ? client.query.bind(client) : query;
  const startsAt = hourStartsAt(hourId);
  await runner(
    `INSERT INTO hours (id, starts_at, ends_at, status)
     VALUES ($1, $2, $3, 'open')
     ON CONFLICT (id) DO NOTHING`,
    [hourId, startsAt, new Date(startsAt.getTime() + HOUR_MS)]
  );
}
async function lockHour(client, hourId) {
  await ensureHour(client, hourId);
  const { rows } = await client.query(`SELECT id, status, starts_at, ends_at, winning_bid_id FROM hours WHERE id = $1 FOR UPDATE`, [hourId]);
  const row = rows[0];
  if (!row) throw new Error(`Hour ${hourId} vanished after insert`);
  return row;
}
async function getPublicState() {
  await settleDueHours();
  const queue = await projectedQueue();
  const frontOfQueueCents = (queue[0]?.amountCents ?? 0) + env.auction.minIncrementCents;
  const now = Date.now();
  const currentId = hourIdAt(now);
  const nextId = currentId + 1;
  const [current, lead, archive, totals] = await Promise.all([
    query(
      `SELECT h.status, h.ends_at, b.display_name, b.tagline, b.link_url, b.logo_data_url, b.amount_cents, b.moderation
         FROM hours h
         LEFT JOIN bids b ON b.id = h.winning_bid_id
        WHERE h.id = $1`,
      [currentId]
    ),
    query(
      `SELECT display_name, amount_cents, moderation
         FROM bids
        WHERE hour_id = $1 AND status = 'active'
        ORDER BY amount_cents DESC, created_at ASC
        LIMIT 1`,
      [nextId]
    ),
    query(
      `SELECT h.id, b.display_name, b.amount_cents, b.moderation
         FROM hours h
         JOIN bids b ON b.id = h.winning_bid_id
        WHERE h.status = 'owned' AND h.id < $1
        ORDER BY h.id DESC
        LIMIT 6`,
      [currentId]
    ),
    query(
      `SELECT count(*)::text AS hours_sold,
              sum(p.amount_cents)::text AS raised,
              max(p.amount_cents) AS highest
         FROM payments p
        WHERE p.status = 'paid'`
    )
  ]);
  const currentRow = current.rows[0];
  const leadRow = lead.rows[0];
  const raisedCents = Number.parseInt(totals.rows[0]?.raised ?? "0", 10) || 0;
  const display = (value, moderation) => moderation === "approved" ? value ?? "" : UNDER_REVIEW;
  return {
    queue,
    frontOfQueueCents,
    serverTime: new Date(now).toISOString(),
    currentHour: {
      id: currentId,
      endsAt: (currentRow?.ends_at ?? new Date(EPOCH_MS + currentId * HOUR_MS)).toISOString(),
      status: currentRow?.status ?? "open",
      owner: currentRow && currentRow.display_name !== null && currentRow.status === "owned" ? {
        name: display(currentRow.display_name, currentRow.moderation),
        tagline: currentRow.moderation === "approved" ? currentRow.tagline ?? "" : "",
        link: currentRow.moderation === "approved" ? currentRow.link_url : null,
        logo: currentRow.moderation === "approved" ? currentRow.logo_data_url : null,
        paidCents: currentRow.amount_cents ?? 0
      } : null
    },
    nextHour: {
      id: nextId,
      startsAt: hourStartsAt(nextId).toISOString(),
      lead: leadRow ? { name: display(leadRow.display_name, leadRow.moderation), amountCents: leadRow.amount_cents } : null,
      minBidCents: leadRow ? leadRow.amount_cents + env.auction.minIncrementCents : env.auction.minBidCents
    },
    archive: archive.rows.map((row) => ({
      hour: row.id,
      name: display(row.display_name, row.moderation),
      amountCents: row.amount_cents
    })),
    totals: {
      hoursSold: Number.parseInt(totals.rows[0]?.hours_sold ?? "0", 10) || 0,
      raisedCents,
      charityCents: splitProceeds(raisedCents).charityCents,
      highestCents: totals.rows[0]?.highest ?? 0
    }
  };
}
async function settleDueHours(now = Date.now()) {
  const currentId = hourIdAt(now);
  const settled = [];
  const { rows: due } = await query(
    `SELECT id FROM hours
      WHERE starts_at <= now() AND winning_bid_id IS NULL AND status = 'open'
      ORDER BY id ASC LIMIT 24`
  );
  for (const hour of [...due.map((row) => row.id), currentId]) {
    const assigned = await tx(async (client) => {
      await ensureHour(client, hour);
      const locked = await lockHour(client, hour);
      if (locked.winning_bid_id !== null) return false;
      if (hourStartsAt(hour).getTime() > now) return false;
      const { rows } = await client.query(
        `SELECT id FROM bids
          WHERE status = 'won' AND hour_id IS NULL
          ORDER BY amount_cents DESC, created_at ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED`
      );
      const top = rows[0];
      if (!top) {
        await client.query(
          `UPDATE hours SET status = 'unsold', settled_at = now() WHERE id = $1 AND status = 'open'`,
          [hour]
        );
        return false;
      }
      await client.query(`UPDATE bids SET hour_id = $1 WHERE id = $2`, [hour, top.id]);
      await client.query(
        `UPDATE hours SET status = 'owned', winning_bid_id = $1, settled_at = now() WHERE id = $2`,
        [top.id, hour]
      );
      await client.query(`UPDATE payments SET hour_id = $1 WHERE bid_id = $2`, [hour, top.id]);
      return true;
    });
    if (assigned) settled.push(hour);
  }
  return settled;
}
async function projectedQueue(limit = 12) {
  const { rows } = await query(
    `SELECT display_name, amount_cents, moderation FROM bids
      WHERE status = 'won' AND hour_id IS NULL
      ORDER BY amount_cents DESC, created_at ASC
      LIMIT $1`,
    [limit]
  );
  return rows.map((row, index) => ({
    position: index + 1,
    name: row.moderation === "approved" ? row.display_name : UNDER_REVIEW,
    amountCents: row.amount_cents
  }));
}

// src-api/state.ts
var state_default = withErrorHandling(async function handler(req, res) {
  requireMethod(req, "GET");
  const state = await getPublicState();
  sendJson(res, 200, state, {
    "Cache-Control": "public, max-age=1, s-maxage=2, stale-while-revalidate=5"
  });
});
export {
  state_default as default
};
