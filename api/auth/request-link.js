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

// lib/validate.ts
var STRIP_PATTERN = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/gu;
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

// lib/crypto.ts
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}
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

// lib/mailer.ts
function escapeHtml(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
async function send(email) {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.email.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: env.email.from,
      to: [email.to],
      subject: email.subject,
      html: email.html,
      text: email.text
    }),
    signal: AbortSignal.timeout(8e3)
  });
  if (!response.ok) {
    console.error("email send failed", { status: response.status });
    throw new Error("Email delivery failed");
  }
}
var shell = (body) => `<!doctype html><html><body style="font-family:ui-monospace,Menlo,monospace;background:#dfe3dc;padding:24px;color:#151815">
<div style="max-width:480px;margin:auto;background:#f0f3ee;border:1px solid #151815;padding:24px">
<div style="font-family:Inter,system-ui,sans-serif;font-weight:900;letter-spacing:-.06em;text-transform:uppercase;font-size:19px;margin-bottom:16px">GetYourHour</div>
${body}
</div></body></html>`;
async function sendLoginLink(to, url) {
  const safeUrl = escapeHtml(url);
  await send({
    to,
    subject: "Your sign-in link for GetYourHour",
    html: shell(
      `<p>Here is your sign-in link. It works once and expires in 15 minutes.</p>
       <p><a href="${safeUrl}" style="display:inline-block;padding:12px 18px;background:#151815;color:#f0f3ee;text-decoration:none">Sign in</a></p>
       <p style="font-size:12px;color:#687069">If you did not request this, you can ignore this email. Nobody can sign in without opening the link.</p>`
    ),
    text: `Sign in to GetYourHour: ${url}

This link works once and expires in 15 minutes. If you did not request it, ignore this email.`
  });
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

// src-api/auth/request-link.ts
var TOKEN_TTL_MINUTES = 15;
var GENERIC_OK = {
  ok: true,
  message: "If that address can bid, a sign-in link is on its way."
};
var request_link_default = withErrorHandling(async function handler(req, res) {
  requireMethod(req, "POST");
  requireSameOrigin(req);
  const ip = clientIp(req);
  const body = await readJsonBody(req);
  const email = validateEmail(body.email);
  const [byEmail, byIp] = await Promise.all([
    consume("login:email", email, env.limits.loginLinksPerEmail, 3600),
    consume("login:ip", ip ?? "unknown", env.limits.loginLinksPerIp, 3600)
  ]);
  if (!byEmail.allowed || !byIp.allowed) {
    await audit({ action: "login.failed", ipHash: hashIp(ip), data: { reason: "rate_limited" } });
    sendJson(res, 200, GENERIC_OK);
    return;
  }
  const { rows } = await query(
    `INSERT INTO users (email) VALUES ($1)
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
     RETURNING id, disabled_at`,
    [email]
  );
  const user = rows[0];
  if (user.disabled_at !== null) {
    await audit({ action: "login.failed", actorId: user.id, ipHash: hashIp(ip), data: { reason: "disabled" } });
    sendJson(res, 200, GENERIC_OK);
    return;
  }
  await query(
    `UPDATE login_tokens SET consumed_at = now()
      WHERE user_id = $1 AND consumed_at IS NULL AND expires_at > now()`,
    [user.id]
  );
  const token = randomToken(32);
  await query(
    `INSERT INTO login_tokens (user_id, token_hash, expires_at, request_ip_hash)
     VALUES ($1, $2, now() + ($3 || ' minutes')::interval, $4)`,
    [user.id, hashToken(token), String(TOKEN_TTL_MINUTES), hashIp(ip)]
  );
  const url = `${env.siteOrigin}/api/auth/verify?token=${encodeURIComponent(token)}`;
  try {
    await sendLoginLink(email, url);
  } catch (error) {
    console.error("login link delivery failed", { message: error.message });
  }
  await audit({ action: "login.requested", actorId: user.id, ipHash: hashIp(ip) });
  sendJson(res, 200, GENERIC_OK);
});
export {
  request_link_default as default
};
