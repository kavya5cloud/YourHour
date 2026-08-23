/**
 * Environment configuration.
 *
 * Every secret is required and validated at module load, so a misconfigured
 * deployment fails immediately and loudly instead of silently running with a
 * weak or empty key. Nothing here has a fallback default -- a default secret is
 * a published secret.
 */

function required(name: string, minLength = 1): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  if (value.length < minLength) {
    throw new Error(`Environment variable ${name} is too short (need >= ${minLength} chars)`);
  }
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
}

function integer(name: string, fallback: number): number {
  const raw = optional(name);
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed)) throw new Error(`Environment variable ${name} must be an integer`);
  return parsed;
}

/** Secrets must carry real entropy; 32 chars is the floor we accept. */
const SECRET_MIN = 32;

export const env = {
  nodeEnv: optional('NODE_ENV') ?? 'development',
  isProduction: (optional('VERCEL_ENV') ?? optional('NODE_ENV')) === 'production',

  /** Canonical public origin, e.g. https://getyourhour.example. Used for cookies,
   *  links in email, and strict Origin checking on state-changing requests. */
  siteOrigin: required('SITE_ORIGIN'),

  databaseUrl: required('DATABASE_URL'),

  /** Key for hashing session/login tokens and IPs. Rotating it logs everyone
   *  out and re-anonymises IP hashes, which is the intended behaviour. */
  secretKey: required('SECRET_KEY', SECRET_MIN),

  /** Shared secret for the scheduled rollover endpoint. */
  cronSecret: required('CRON_SECRET', SECRET_MIN),

  polar: {
    accessToken: required('POLAR_ACCESS_TOKEN'),
    webhookSecret: required('POLAR_WEBHOOK_SECRET'),
    productId: required('POLAR_PRODUCT_ID'),
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
    apiBase: 'https://api.polar.sh',
  },

  email: {
    apiKey: required('RESEND_API_KEY'),
    from: required('EMAIL_FROM'),
  },

  /** Comma-separated user ids allowed to reach moderation endpoints. */
  moderatorIds: (optional('MODERATOR_USER_IDS') ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean),

  auction: {
    /** Minimum opening bid and minimum raise over the standing bid, in cents. */
    minBidCents: integer('MIN_BID_CENTS', 100),
    minIncrementCents: integer('MIN_INCREMENT_CENTS', 100),
    /** Upper bound on a single bid, a guard against fat-finger and abuse. */
    maxBidCents: integer('MAX_BID_CENTS', 100_000_00),
    /**
     * Ceiling for a bidder who has not yet proved they own their email address.
     *
     * Bidding is open to anyone with an email box, which is what keeps the
     * hourly cadence usable. The cost is that an unverified stranger could
     * otherwise park an enormous bid on an hour and simply never pay, denying
     * it to real bidders. Capping unverified bids bounds the damage of that to
     * something small, while leaving casual bidding frictionless.
     */
    maxUnverifiedBidCents: integer('MAX_UNVERIFIED_BID_CENTS', 5_000),
    /**
     * Claim pricing. An hour's price falls the further out it is, so paying
     * more buys a sooner slot without anyone ever being displaced:
     *   price(hoursAway) = max(floor, round(base / hoursAway))
     * With the defaults that is $50 for the next hour, $25 two out, $10 five
     * out, and $5 for anything ten hours or further away.
     */
    claimBaseCents: integer('CLAIM_BASE_CENTS', 5_000),
    claimFloorCents: integer('CLAIM_FLOOR_CENTS', 500),
    /** How far ahead the board is open for claiming. */
    claimHorizonHours: integer('CLAIM_HORIZON_HOURS', 24),
    /** How long a slot is held while the buyer is inside Polar checkout. */
    reservationSeconds: integer('RESERVATION_SECONDS', 600),
    /** How long a winner has to complete checkout. */
    paymentWindowSeconds: integer('PAYMENT_WINDOW_SECONDS', 300),
    /** Share of net proceeds pledged to charity, in basis points. */
    charityBasisPoints: integer('CHARITY_BASIS_POINTS', 5000),
    /** Provider fee estimate used to compute net, in basis points + fixed. */
    feeBasisPoints: integer('FEE_BASIS_POINTS', 290),
    feeFixedCents: integer('FEE_FIXED_CENTS', 30),
    /**
     * When false, a winning listing shows a neutral placeholder until a
     * moderator approves it. Turning this on trades human review for
     * immediacy, and puts unreviewed user text on the homepage.
     */
    autoApproveListings: (optional('LISTING_AUTO_APPROVE') ?? 'false') === 'true',
  },

  limits: {
    /** Bids allowed per user and per IP inside a rolling window. */
    bidsPerUserPerHour: integer('RATE_BIDS_PER_USER', 30),
    bidsPerIpPerHour: integer('RATE_BIDS_PER_IP', 60),
    loginLinksPerEmail: integer('RATE_LOGIN_PER_EMAIL', 5),
    loginLinksPerIp: integer('RATE_LOGIN_PER_IP', 20),
  },
} as const;

/** The origin's host, used for Origin/Referer validation. */
export const siteUrl = new URL(env.siteOrigin);

if (env.isProduction && siteUrl.protocol !== 'https:') {
  throw new Error('SITE_ORIGIN must use https in production');
}
