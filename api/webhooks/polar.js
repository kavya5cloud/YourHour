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
var badRequest = (message, code = "bad_request") => new HttpError(400, message, code);
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
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new HttpError(413, "Request body too large.", "payload_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", () => reject(new HttpError(400, "Could not read request body.", "bad_body")));
  });
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

// lib/polar.ts
import { createHmac, timingSafeEqual } from "node:crypto";
var SIGNATURE_TOLERANCE_SECONDS = 300;
function verifyWebhook(rawBody, headers) {
  const header = (name) => {
    const value = headers[name];
    const single = Array.isArray(value) ? value[0] : value;
    return typeof single === "string" && single !== "" ? single : null;
  };
  const id = header("webhook-id");
  const timestamp = header("webhook-timestamp");
  const signatureHeader = header("webhook-signature");
  if (!id || !timestamp || !signatureHeader) {
    throw new Error("Missing webhook signature headers");
  }
  const sentAt = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(sentAt)) throw new Error("Invalid webhook timestamp");
  const skew = Math.abs(Math.floor(Date.now() / 1e3) - sentAt);
  if (skew > SIGNATURE_TOLERANCE_SECONDS) throw new Error("Webhook timestamp outside tolerance");
  const secret = env.polar.webhookSecret.startsWith("whsec_") ? Buffer.from(env.polar.webhookSecret.slice("whsec_".length), "base64") : Buffer.from(env.polar.webhookSecret, "utf8");
  const expected = createHmac("sha256", secret).update(`${id}.${sentAt}.${rawBody.toString("utf8")}`, "utf8").digest();
  const candidates = signatureHeader.split(" ").map((entry) => entry.trim()).filter((entry) => entry.startsWith("v1,")).map((entry) => Buffer.from(entry.slice(3), "base64"));
  const matched = candidates.some(
    (candidate) => candidate.length === expected.length && timingSafeEqual(candidate, expected)
  );
  if (!matched) throw new Error("Webhook signature mismatch");
  let parsed;
  try {
    parsed = JSON.parse(rawBody.toString("utf8"));
  } catch {
    throw new Error("Webhook body is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null) throw new Error("Webhook body is not an object");
  const event = parsed;
  if (typeof event.type !== "string") throw new Error("Webhook event has no type");
  return {
    // `webhook-id` is the delivery identifier used for idempotency.
    id,
    type: event.type,
    data: typeof event.data === "object" && event.data !== null ? event.data : {}
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

// lib/audit.ts
async function audit(entry) {
  try {
    await query(
      `INSERT INTO audit_log (action, actor_id, subject, ip_hash, data)
       VALUES ($1, $2, $3, $4, $5)`,
      [entry.action, entry.actorId ?? null, entry.subject ?? null, entry.ipHash ?? null, entry.data ?? {}]
    );
  } catch (error) {
    console.error("audit write failed", { action: entry.action, message: error.message });
  }
}

// lib/validate.ts
function validateUuid(raw, field = "id") {
  const pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (typeof raw !== "string" || !pattern.test(raw)) {
    throw badRequest(`Invalid ${field}.`, "invalid_id");
  }
  return raw.toLowerCase();
}

// lib/auction.ts
var HOUR_MS = 36e5;
var EPOCH_MS = Date.UTC(2024, 0, 1, 0, 0, 0);
function hourStartsAt(hourId) {
  return new Date(EPOCH_MS + (hourId - 1) * HOUR_MS);
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
async function markPaid(paymentId, providerOrderId) {
  return tx(async (client) => {
    const { rows } = await client.query(
      `UPDATE payments
          SET status = 'paid', paid_at = now(), provider_order_id = COALESCE($2, provider_order_id)
        WHERE id = $1 AND status = 'pending'
        RETURNING hour_id, bid_id, user_id, amount_cents`,
      [paymentId, providerOrderId]
    );
    const payment = rows[0];
    if (!payment) return false;
    await lockHour(client, payment.hour_id);
    await client.query(
      `UPDATE hours SET status = 'owned', winning_bid_id = $1, settled_at = now()
        WHERE id = $2 AND status IN ('open', 'awaiting_payment', 'forfeited')`,
      [payment.bid_id, payment.hour_id]
    );
    await client.query(`UPDATE bids SET status = 'won' WHERE id = $1`, [payment.bid_id]);
    await client.query(
      `UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1`,
      [payment.user_id]
    );
    await audit({
      action: "payment.paid",
      actorId: payment.user_id,
      subject: `hour:${payment.hour_id}`,
      data: { amountCents: payment.amount_cents, paymentId }
    });
    return true;
  });
}
async function markRefunded(paymentId) {
  return tx(async (client) => {
    const { rows } = await client.query(
      `UPDATE payments SET status = 'refunded'
        WHERE id = $1 AND status IN ('paid', 'pending')
        RETURNING hour_id, bid_id`,
      [paymentId]
    );
    const payment = rows[0];
    if (!payment) return false;
    await lockHour(client, payment.hour_id);
    await client.query(
      `UPDATE hours SET status = 'forfeited', winning_bid_id = NULL WHERE id = $1`,
      [payment.hour_id]
    );
    await audit({ action: "payment.refunded", subject: `hour:${payment.hour_id}`, data: { paymentId } });
    return true;
  });
}
async function findPaymentByCheckout(checkoutId) {
  const { rows } = await query(`SELECT id FROM payments WHERE provider_checkout_id = $1`, [
    checkoutId
  ]);
  return rows[0] ?? null;
}

// src-api/webhooks/polar.ts
var config = { api: { bodyParser: false } };
async function resolvePaymentId(data) {
  const metadata = data.metadata ?? {};
  const fromMetadata = metadata.payment_id;
  if (typeof fromMetadata === "string") {
    try {
      return validateUuid(fromMetadata, "payment_id");
    } catch {
      return null;
    }
  }
  const checkoutId = data.checkout_id ?? data.checkout?.id ?? data.id;
  if (typeof checkoutId === "string" && checkoutId.length > 0 && checkoutId.length < 200) {
    const payment = await findPaymentByCheckout(checkoutId);
    return payment?.id ?? null;
  }
  return null;
}
var polar_default = withErrorHandling(async function handler(req, res) {
  requireMethod(req, "POST");
  const raw = await readRawBody(req);
  if (raw.length === 0) {
    sendJson(res, 400, { error: "invalid" });
    return;
  }
  let event;
  try {
    event = verifyWebhook(raw, req.headers);
  } catch (error) {
    console.warn("webhook rejected", { message: error.message });
    await audit({ action: "webhook.rejected", data: { reason: "signature" } });
    sendJson(res, 400, { error: "invalid" });
    return;
  }
  const { rowCount } = await query(
    `INSERT INTO webhook_events (provider, event_id, event_type)
     VALUES ('polar', $1, $2)
     ON CONFLICT (provider, event_id) DO NOTHING`,
    [event.id, event.type]
  );
  if (rowCount === 0) {
    sendJson(res, 200, { ok: true, duplicate: true });
    return;
  }
  await audit({ action: "webhook.received", subject: event.id, data: { type: event.type } });
  const paymentId = await resolvePaymentId(event.data);
  switch (event.type) {
    case "order.paid":
    case "checkout.updated": {
      if (event.type === "checkout.updated" && event.data.status !== "succeeded") break;
      if (!paymentId) {
        console.warn("paid event with no resolvable payment", { eventId: event.id });
        break;
      }
      const orderId = typeof event.data.id === "string" ? event.data.id : null;
      await markPaid(paymentId, orderId);
      break;
    }
    case "order.refunded": {
      if (paymentId) await markRefunded(paymentId);
      break;
    }
    default:
      break;
  }
  sendJson(res, 200, { ok: true });
});
export {
  config,
  polar_default as default
};
