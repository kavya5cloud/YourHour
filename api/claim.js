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
var forbidden = (message = "Not allowed.") => new HttpError(403, message, "forbidden");
var conflict = (message, code = "conflict") => new HttpError(409, message, code);
var tooMany = (message, retryAfterSeconds) => new HttpError(429, message, "rate_limited", { "Retry-After": String(retryAfterSeconds) });
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
function bucketKey(scope, identifier) {
  return `${scope}:${createHmac("sha256", env.secretKey).update(identifier, "utf8").digest("base64url")}`;
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

// lib/session.ts
var SESSION_COOKIE = env.isProduction ? "__Host-th_session" : "th_session";
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

// lib/ratelimit.ts
async function consume(scope, identifier, limit, windowSeconds) {
  const now = Date.now();
  const windowMs = windowSeconds * 1e3;
  const windowStart = new Date(Math.floor(now / windowMs) * windowMs);
  const key = bucketKey(scope, identifier);
  const { rows } = await query(
    `INSERT INTO rate_limits (bucket, window_start, count)
     VALUES ($1, $2, 1)
     ON CONFLICT (bucket) DO UPDATE
       SET count = CASE WHEN rate_limits.window_start = $2 THEN rate_limits.count + 1 ELSE 1 END,
           window_start = $2
     RETURNING count`,
    [key, windowStart]
  );
  const count = rows[0]?.count ?? 1;
  const retryAfterSeconds = Math.max(1, Math.ceil((windowStart.getTime() + windowMs - now) / 1e3));
  return {
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
    retryAfterSeconds
  };
}
async function enforce(scope, identifier, limit, windowSeconds, message = "Too many requests. Try again shortly.") {
  const subject = identifier ?? "unknown";
  const result = await consume(scope, subject, limit, windowSeconds);
  if (!result.allowed) throw tooMany(message, result.retryAfterSeconds);
}

// lib/validate.ts
var STRIP_PATTERN = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/gu;
var BREAK_PATTERN = /[\u0009-\u000D\u0085\u2028\u2029]/gu;
function cleanText(raw, field) {
  if (typeof raw !== "string") throw badRequest(`${field} must be text.`);
  const capped = raw.slice(0, 4096);
  return capped.normalize("NFC").replace(BREAK_PATTERN, " ").replace(STRIP_PATTERN, "").replace(/\s+/gu, " ").trim();
}
function hasSubstance(value) {
  return /[\p{L}\p{N}\p{S}]/u.test(value);
}
function validateDisplayName(raw) {
  const value = cleanText(raw, "Name");
  if (value.length === 0) throw badRequest("Add a name or link first.", "name_required");
  if (value.length > 24) throw badRequest("Name must be 24 characters or fewer.", "name_too_long");
  if (!hasSubstance(value)) throw badRequest("That name needs readable characters.", "name_invalid");
  return value;
}
function validateTagline(raw) {
  if (raw === void 0 || raw === null || raw === "") return "";
  const value = cleanText(raw, "Message");
  if (value.length > 90) throw badRequest("Message must be 90 characters or fewer.", "tagline_too_long");
  if (value.length > 0 && !hasSubstance(value)) {
    throw badRequest("That message needs readable characters.", "tagline_invalid");
  }
  return value;
}
function validateEmail(raw) {
  if (typeof raw !== "string") throw badRequest("Enter an email address.", "email_required");
  const value = raw.slice(0, 320).normalize("NFC").replace(STRIP_PATTERN, "").trim().toLowerCase();
  if (value.length === 0) throw badRequest("Enter an email address.", "email_required");
  if (value.length > 254) throw badRequest("That email address is too long.", "email_invalid");
  const parts = value.split("@");
  if (parts.length !== 2) throw badRequest("Enter a valid email address.", "email_invalid");
  const [local, domain] = parts;
  if (local.length === 0 || local.length > 64) throw badRequest("Enter a valid email address.", "email_invalid");
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)) {
    throw badRequest("Enter a valid email address.", "email_invalid");
  }
  if (!/^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
    throw badRequest("Enter a valid email address.", "email_invalid");
  }
  return value;
}
function validateLinkUrl(raw) {
  if (raw === void 0 || raw === null || raw === "") {
    throw badRequest("Add the link your hour should point to.", "link_required");
  }
  if (typeof raw !== "string") throw badRequest("Link must be text.", "link_invalid");
  const value = cleanText(raw, "Link");
  if (value.length === 0) {
    throw badRequest("Add the link your hour should point to.", "link_required");
  }
  if (value.length > 200) throw badRequest("That link is too long.", "link_too_long");
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`);
  } catch {
    throw badRequest("That does not look like a valid link.", "link_invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw badRequest("Links must start with http or https.", "link_scheme");
  }
  if (url.username !== "" || url.password !== "") {
    throw badRequest("Links cannot contain credentials.", "link_invalid");
  }
  if (!url.hostname.includes(".") || url.hostname.endsWith(".")) {
    throw badRequest("That does not look like a valid link.", "link_invalid");
  }
  return url.toString();
}
var LOGO_MAX_CHARS = 32768;
var LOGO_SIGNATURES = {
  "image/png": [[137, 80, 78, 71, 13, 10, 26, 10]],
  "image/jpeg": [[255, 216, 255]],
  // RIFF....WEBP -- the four bytes at offset 4 are the length, so check both ends.
  "image/webp": [[82, 73, 70, 70]]
};
function startsWithBytes(buffer, signature) {
  if (buffer.length < signature.length) return false;
  return signature.every((byte, index) => buffer[index] === byte);
}
function validateLogo(raw) {
  if (raw === void 0 || raw === null || raw === "") return null;
  if (typeof raw !== "string") throw badRequest("Logo must be an image.", "logo_invalid");
  const value = raw.trim();
  if (value.length === 0) return null;
  if (value.length > LOGO_MAX_CHARS) {
    throw badRequest("That logo is too large. Use a smaller image.", "logo_too_large");
  }
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) throw badRequest("Logo must be a PNG, JPEG, or WebP image.", "logo_invalid");
  const mime = match[1];
  const encoded = match[2];
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length === 0) throw badRequest("That logo could not be read.", "logo_invalid");
  const signatures = LOGO_SIGNATURES[mime];
  if (!signatures.some((signature) => startsWithBytes(bytes, signature))) {
    throw badRequest("That file is not a valid image.", "logo_invalid");
  }
  if (mime === "image/webp" && bytes.subarray(8, 12).toString("ascii") !== "WEBP") {
    throw badRequest("That file is not a valid image.", "logo_invalid");
  }
  return `data:${mime};base64,${bytes.toString("base64")}`;
}
function validateBidDollars(raw) {
  let dollars;
  if (typeof raw === "number") {
    dollars = raw;
  } else if (typeof raw === "string") {
    const trimmed = raw.trim().replace(/^\$/, "").replace(/,/g, "");
    if (!/^\d{1,9}$/.test(trimmed)) throw badRequest("Enter a whole-dollar bid.", "amount_invalid");
    dollars = Number.parseInt(trimmed, 10);
  } else {
    throw badRequest("Enter a whole-dollar bid.", "amount_invalid");
  }
  if (!Number.isInteger(dollars) || dollars <= 0) throw badRequest("Enter a whole-dollar bid.", "amount_invalid");
  const cents = dollars * 100;
  if (cents < env.auction.minBidCents) {
    throw badRequest(`Bids start at ${formatMoney(env.auction.minBidCents)}.`, "amount_too_low");
  }
  if (cents > env.auction.maxBidCents) {
    throw badRequest(`Bids are capped at ${formatMoney(env.auction.maxBidCents)}.`, "amount_too_high");
  }
  return cents;
}
function formatMoney(cents) {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
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

// lib/polar.ts
async function createCheckout(options) {
  const response = await fetch(`${env.polar.apiBase}/v1/checkouts/`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.polar.accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      product_id: env.polar.productId,
      amount: options.amountCents,
      customer_email: options.email,
      success_url: `${env.siteOrigin}/?paid=1`,
      metadata: {
        bid_id: options.bidId,
        payment_id: options.paymentId
      }
    }),
    signal: AbortSignal.timeout(1e4)
  });
  if (!response.ok) {
    console.error("polar checkout creation failed", { status: response.status });
    throw new Error("Could not create checkout session");
  }
  const data = await response.json();
  if (typeof data.id !== "string" || typeof data.url !== "string") {
    throw new Error("Malformed checkout response from Polar");
  }
  const url = new URL(data.url);
  if (url.protocol !== "https:") throw new Error("Checkout URL was not https");
  return { id: data.id, url: url.toString() };
}

// lib/auction.ts
var EPOCH_MS = Date.UTC(2024, 0, 1, 0, 0, 0);
function splitProceeds(amountCents) {
  const feeCents = Math.min(
    amountCents,
    Math.round(amountCents * env.auction.feeBasisPoints / 1e4) + env.auction.feeFixedCents
  );
  const netCents = Math.max(0, amountCents - feeCents);
  const charityCents = Math.floor(netCents * env.auction.charityBasisPoints / 1e4);
  return { amountCents, feeCents, netCents, charityCents };
}
async function purchase(input) {
  if (input.amountCents < env.auction.minBidCents) {
    throw conflict(`The minimum is ${formatMoney(env.auction.minBidCents)}.`, "amount_too_low");
  }
  const split = splitProceeds(input.amountCents);
  const moderation = env.auction.autoApproveListings ? "approved" : "pending";
  return tx(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO bids (hour_id, user_id, amount_cents, display_name, tagline,
                         link_url, logo_data_url, ip_hash, moderation)
       VALUES (NULL, $1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        input.userId,
        input.amountCents,
        input.displayName,
        input.tagline,
        input.linkUrl,
        input.logoDataUrl,
        input.ipHash,
        moderation
      ]
    );
    const bidId = rows[0].id;
    const { rows: paymentRows } = await client.query(
      `INSERT INTO payments (hour_id, bid_id, user_id, amount_cents, fee_cents, charity_cents, expires_at)
       VALUES (NULL, $1, $2, $3, $4, $5, now() + interval '1 day')
       RETURNING id`,
      [bidId, input.userId, input.amountCents, split.feeCents, split.charityCents]
    );
    return { bidId, paymentId: paymentRows[0].id, amountCents: input.amountCents };
  });
}
async function releaseClaim(bidId) {
  await tx(async (client) => {
    await client.query(`UPDATE bids SET status = 'lost' WHERE id = $1 AND status = 'active'`, [bidId]);
    await client.query(
      `UPDATE payments SET status = 'failed' WHERE bid_id = $1 AND status = 'pending'`,
      [bidId]
    );
  });
}

// lib/logo.ts
var LOOKUP_TIMEOUT_MS = 3e3;
var MAX_BYTES = 24e3;
function sniffImageType(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
    return "image/jpeg";
  }
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  return null;
}
async function fetchLogoForLink(linkUrl) {
  let host;
  try {
    host = new URL(linkUrl).hostname;
  } catch {
    return null;
  }
  if (host === "" || !host.includes(".")) return null;
  try {
    const response = await fetch(
      `https://www.google.com/s2/favicons?sz=128&domain=${encodeURIComponent(host)}`,
      { signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS), redirect: "follow" }
    );
    if (!response.ok) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_BYTES) return null;
    const type = sniffImageType(bytes);
    if (!type) return null;
    return validateLogo(`data:${type};base64,${bytes.toString("base64")}`);
  } catch {
    return null;
  }
}

// src-api/claim.ts
async function resolveBuyer(req, body) {
  const session = await getSession(req);
  if (session) return { id: session.userId, email: session.email };
  const email = validateEmail(body.email);
  const { rows } = await query(
    `INSERT INTO users (email) VALUES ($1)
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
     RETURNING id, disabled_at`,
    [email]
  );
  const user = rows[0];
  if (user.disabled_at !== null) throw badRequest("That account cannot claim hours.", "account_disabled");
  return { id: user.id, email };
}
var claim_default = withErrorHandling(async function handler(req, res) {
  requireMethod(req, "POST");
  requireSameOrigin(req);
  const ip = clientIp(req);
  const ipHash = hashIp(ip);
  await enforce("claim:ip", ip, env.limits.bidsPerIpPerHour, 3600, "Too many attempts from this connection.");
  const body = await readJsonBody(req);
  const buyer = await resolveBuyer(req, body);
  await enforce("claim:user", buyer.id, env.limits.bidsPerUserPerHour, 3600, "You are going too quickly.");
  const amountCents = validateBidDollars(body.amount);
  const displayName = validateDisplayName(body.name);
  const tagline = validateTagline(body.message);
  const linkUrl = validateLinkUrl(body.link);
  const logoDataUrl = validateLogo(body.logo) ?? await fetchLogoForLink(linkUrl);
  const claim = await purchase({
    amountCents,
    userId: buyer.id,
    displayName,
    tagline,
    linkUrl,
    logoDataUrl,
    ipHash
  });
  let checkout;
  try {
    checkout = await createCheckout({
      amountCents: claim.amountCents,
      email: buyer.email,
      bidId: claim.bidId,
      paymentId: claim.paymentId
    });
  } catch (error) {
    await releaseClaim(claim.bidId);
    await audit({
      action: "claim.released",
      actorId: buyer.id,
      subject: `bid:${claim.bidId}`,
      data: { reason: "checkout_failed" }
    });
    throw error;
  }
  await query(`UPDATE payments SET provider_checkout_id = $1 WHERE id = $2`, [
    checkout.id,
    claim.paymentId
  ]);
  await audit({
    action: "claim.opened",
    actorId: buyer.id,
    subject: `bid:${claim.bidId}`,
    ipHash,
    data: { bidId: claim.bidId, amountCents: claim.amountCents }
  });
  sendJson(res, 201, {
    ok: true,
    amountCents: claim.amountCents,
    checkoutUrl: checkout.url,
    listing: { name: displayName, tagline, link: linkUrl, logo: logoDataUrl }
  });
});
export {
  claim_default as default
};
