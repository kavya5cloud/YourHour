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
function clientIp(req) {
  const header = (name) => {
    const value = req.headers[name];
    const single = Array.isArray(value) ? value[0] : value;
    return single ? single.split(",")[0].trim() : null;
  };
  return header("x-vercel-forwarded-for") ?? header("x-real-ip") ?? req.socket?.remoteAddress ?? null;
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
var SESSION_TTL_DAYS = 30;
function appendCookie(res, value) {
  const existing = res.getHeader("Set-Cookie");
  const list = existing === void 0 ? [] : Array.isArray(existing) ? existing : [String(existing)];
  list.push(value);
  res.setHeader("Set-Cookie", list);
}
function setSessionCookie(res, token, expiresAt) {
  const attributes = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    // Lax rather than Strict so that following the emailed magic link into the
    // site keeps the session; every state-changing route still checks Origin.
    "SameSite=Lax",
    `Expires=${expiresAt.toUTCString()}`,
    `Max-Age=${Math.floor((expiresAt.getTime() - Date.now()) / 1e3)}`
  ];
  if (env.isProduction) attributes.push("Secure");
  appendCookie(res, attributes.join("; "));
}
function csrfTokenFor(sessionId) {
  return hashToken(`csrf:${sessionId}`).toString("base64url");
}
async function createSession(userId, ip, userAgent) {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1e3);
  const { rows } = await query(
    `INSERT INTO sessions (user_id, token_hash, csrf_hash, expires_at, ip_hash, user_agent)
     VALUES ($1, $2, '\\x00'::bytea, $3, $4, $5)
     RETURNING id`,
    [userId, hashToken(token), expiresAt, hashIp(ip), userAgent?.slice(0, 300) ?? null]
  );
  const sessionId = rows[0].id;
  const csrfToken = csrfTokenFor(sessionId);
  await query(`UPDATE sessions SET csrf_hash = $1 WHERE id = $2`, [hashToken(csrfToken), sessionId]);
  return { token, csrfToken, expiresAt };
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

// src-api/auth/verify.ts
function redirect(res, path) {
  applySecurityHeaders(res);
  res.statusCode = 303;
  res.setHeader("Location", `${env.siteOrigin}${path}`);
  res.end();
}
var verify_default = withErrorHandling(async function handler(req, res) {
  requireMethod(req, "GET");
  const ip = clientIp(req);
  const attempt = await consume("login:verify", ip ?? "unknown", 30, 3600);
  if (!attempt.allowed) {
    redirect(res, "/?signin=throttled");
    return;
  }
  const url = new URL(req.url ?? "/", env.siteOrigin);
  const token = url.searchParams.get("token");
  if (!token || token.length < 20 || token.length > 128) {
    redirect(res, "/?signin=invalid");
    return;
  }
  const { rows } = await query(
    `UPDATE login_tokens
        SET consumed_at = now()
      WHERE token_hash = $1
        AND consumed_at IS NULL
        AND expires_at > now()
      RETURNING user_id`,
    [hashToken(token)]
  );
  const consumed = rows[0];
  if (!consumed) {
    await audit({ action: "login.failed", ipHash: hashIp(ip), data: { reason: "bad_or_used_token" } });
    redirect(res, "/?signin=expired");
    return;
  }
  const { rows: userRows } = await query(
    `SELECT id FROM users WHERE id = $1 AND disabled_at IS NULL`,
    [consumed.user_id]
  );
  if (!userRows[0]) {
    redirect(res, "/?signin=invalid");
    return;
  }
  const userAgent = req.headers["user-agent"];
  const session = await createSession(
    consumed.user_id,
    ip,
    Array.isArray(userAgent) ? userAgent[0] ?? null : userAgent ?? null
  );
  setSessionCookie(res, session.token, session.expiresAt);
  await query(
    `UPDATE users
        SET last_login_at = now(),
            email_verified_at = COALESCE(email_verified_at, now())
      WHERE id = $1`,
    [consumed.user_id]
  );
  await audit({ action: "login.verified", actorId: consumed.user_id, ipHash: hashIp(ip) });
  redirect(res, "/?signin=ok");
});
export {
  verify_default as default
};
