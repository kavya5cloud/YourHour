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
    /**
     * Always production Polar.
     *
     * This was configurable, and the sandbox base broke the live site twice --
     * a sandbox URL with a production token returns 401 on every checkout,
     * which surfaces as an opaque 500 and takes the buying path down while
     * everything that does not touch Polar keeps working. Nothing in a
     * deployment needs sandbox, so the setting is gone rather than left as a
     * footgun that only misfires in production.
     */
    apiBase: "https://api.polar.sh"
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
var unauthorized = (message = "Sign in to continue.") => new HttpError(401, message, "unauthorized");
var forbidden = (message = "Not allowed.") => new HttpError(403, message, "forbidden");
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
async function readJsonBody(req) {
  if (req.body !== void 0 && req.body !== null) {
    if (typeof req.body === "object" && !Array.isArray(req.body)) {
      return req.body;
    }
    throw badRequest("Expected a JSON object.");
  }
  const raw = await readRawBody(req);
  if (raw.length === 0) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw badRequest("Body is not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw badRequest("Expected a JSON object.");
  }
  const safe = /* @__PURE__ */ Object.create(null);
  for (const [key, value] of Object.entries(parsed)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    safe[key] = value;
  }
  return safe;
}
function clientIp(req) {
  const header = (name) => {
    const value = req.headers[name];
    const single = Array.isArray(value) ? value[0] : value;
    return single ? single.split(",")[0].trim() : null;
  };
  return header("x-vercel-forwarded-for") ?? header("x-real-ip") ?? req.socket?.remoteAddress ?? null;
}
function requireSameOrigin(req) {
  const origin = req.headers.origin;
  if (typeof origin === "string" && origin !== "") {
    if (origin !== siteUrl.origin) throw forbidden("Cross-origin request rejected.");
    return;
  }
  const referer = req.headers.referer;
  if (typeof referer === "string" && referer !== "") {
    try {
      if (new URL(referer).origin === siteUrl.origin) return;
    } catch {
    }
  }
  throw forbidden("Could not verify request origin.");
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

// lib/crypto.ts
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
function hashToken(token) {
  return createHmac("sha256", env.secretKey).update(token, "utf8").digest();
}
function hashIp(ip) {
  if (!ip) return null;
  return createHmac("sha256", env.secretKey).update(`ip:${ip}`, "utf8").digest();
}
function safeEqual(a, b) {
  const left = Buffer.isBuffer(a) ? a : Buffer.from(a, "utf8");
  const right = Buffer.isBuffer(b) ? b : Buffer.from(b, "utf8");
  const leftDigest = createHmac("sha256", env.secretKey).update(left).digest();
  const rightDigest = createHmac("sha256", env.secretKey).update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
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

// lib/session.ts
var SESSION_COOKIE = env.isProduction ? "__Host-th_session" : "th_session";
var CSRF_HEADER = "x-csrf-token";
function parseCookies(req) {
  const header = req.headers.cookie;
  const jar = /* @__PURE__ */ Object.create(null);
  if (!header) return jar;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name) jar[name] = decodeURIComponent(value);
  }
  return jar;
}
async function getSession(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token || token.length < 20 || token.length > 128) return null;
  const { rows } = await query(
    `SELECT s.id, s.user_id, u.email, s.csrf_hash
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > now()
        AND u.disabled_at IS NULL`,
    [hashToken(token)]
  );
  const row = rows[0];
  if (!row) return null;
  void query(`UPDATE sessions SET last_seen_at = now() WHERE id = $1 AND last_seen_at < now() - interval '1 minute'`, [
    row.id
  ]).catch(() => void 0);
  return { id: row.id, userId: row.user_id, email: row.email, csrfHash: row.csrf_hash };
}
async function requireSession(req) {
  const session = await getSession(req);
  if (!session) throw unauthorized();
  return session;
}
function requireCsrf(req, session) {
  const header = req.headers[CSRF_HEADER];
  const provided = Array.isArray(header) ? header[0] : header;
  if (!provided || typeof provided !== "string") throw forbidden("Missing CSRF token.");
  if (!safeEqual(hashToken(provided), session.csrfHash)) throw forbidden("Invalid CSRF token.");
}

// lib/validate.ts
function validateUuid(raw, field = "id") {
  const pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (typeof raw !== "string" || !pattern.test(raw)) {
    throw badRequest(`Invalid ${field}.`, "invalid_id");
  }
  return raw.toLowerCase();
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

// src-api/moderation.ts
function requireModerator(session) {
  if (!env.moderatorIds.includes(session.userId)) {
    throw forbidden("Not allowed.");
  }
}
var moderation_default = withErrorHandling(async function handler(req, res) {
  requireMethod(req, "GET", "POST");
  const session = await requireSession(req);
  requireModerator(session);
  if (req.method === "GET") {
    const { rows } = await query(
      `SELECT b.id, b.hour_id, b.display_name, b.tagline, b.link_url, b.logo_data_url, b.amount_cents, b.created_at
         FROM bids b
        WHERE b.moderation = 'pending' AND b.status IN ('active', 'won')
        ORDER BY b.hour_id ASC, b.amount_cents DESC
        LIMIT 100`
    );
    sendJson(res, 200, { pending: rows });
    return;
  }
  requireSameOrigin(req);
  requireCsrf(req, session);
  const body = await readJsonBody(req);
  const bidId = validateUuid(body.bidId, "bidId");
  const decision = body.decision;
  if (decision !== "approved" && decision !== "rejected") {
    throw badRequest('Decision must be "approved" or "rejected".', "bad_decision");
  }
  const { rowCount } = await query(`UPDATE bids SET moderation = $1 WHERE id = $2`, [decision, bidId]);
  if (rowCount === 0) throw badRequest("No such bid.", "not_found");
  await audit({
    action: "moderation.updated",
    actorId: session.userId,
    subject: `bid:${bidId}`,
    ipHash: hashIp(clientIp(req)),
    data: { decision }
  });
  sendJson(res, 200, { ok: true, bidId, decision });
});
export {
  moderation_default as default
};
