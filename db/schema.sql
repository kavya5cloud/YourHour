-- The Hour — schema.
-- Money is stored as integer cents everywhere. Never floats.
-- All timestamps are timestamptz; the database clock is the only clock that
-- decides auction outcomes.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid
CREATE EXTENSION IF NOT EXISTS citext;     -- case-insensitive email

-- ---------------------------------------------------------------- accounts

CREATE TABLE IF NOT EXISTS users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          citext NOT NULL UNIQUE,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_login_at  timestamptz,
  -- Set to block an abusive account. Checked on every authenticated request.
  disabled_at    timestamptz,
  disabled_reason text
);

-- Passwordless login. We store only a SHA-256 hash of the token, so a database
-- leak does not hand an attacker a set of usable login links.
CREATE TABLE IF NOT EXISTS login_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   bytea NOT NULL UNIQUE,
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  request_ip_hash bytea
);
CREATE INDEX IF NOT EXISTS login_tokens_user_idx ON login_tokens (user_id, created_at DESC);

-- Server-side sessions so that logout and account disable take effect
-- immediately. The cookie carries an opaque secret; we store only its hash.
CREATE TABLE IF NOT EXISTS sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    bytea NOT NULL UNIQUE,
  csrf_hash     bytea NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  ip_hash       bytea,
  user_agent    text
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;

-- ----------------------------------------------------------------- auction

DO $$ BEGIN
  -- open             : accepting bids
  -- awaiting_payment : rolled over; a winner is inside their payment window
  -- owned            : paid for and on display
  -- unsold           : closed with no bids
  -- forfeited        : every bidder in turn failed to pay in time
  CREATE TYPE hour_status AS ENUM ('open', 'awaiting_payment', 'owned', 'unsold', 'forfeited');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- One row per clock hour. `id` is the public hour number shown on the page.
CREATE TABLE IF NOT EXISTS hours (
  id             bigint PRIMARY KEY,
  starts_at      timestamptz NOT NULL UNIQUE,
  ends_at        timestamptz NOT NULL,
  status         hour_status NOT NULL DEFAULT 'open',
  winning_bid_id uuid,
  settled_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hours_span_valid CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS hours_status_idx ON hours (status, starts_at);

DO $$ BEGIN
  CREATE TYPE bid_status AS ENUM ('active', 'outbid', 'won', 'forfeited', 'lost');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS bids (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hour_id      bigint NOT NULL REFERENCES hours(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_cents integer NOT NULL,
  -- Listing content, already normalised and validated by the server.
  display_name text NOT NULL,
  tagline      text NOT NULL DEFAULT '',
  link_url     text,
  status       bid_status NOT NULL DEFAULT 'active',
  created_at   timestamptz NOT NULL DEFAULT now(),
  ip_hash      bytea,
  -- Listings are held until reviewed; only 'approved' content is ever served
  -- as the current owner of the page.
  moderation   text NOT NULL DEFAULT 'pending',
  CONSTRAINT bids_amount_positive CHECK (amount_cents > 0),
  CONSTRAINT bids_amount_sane CHECK (amount_cents <= 100000000),
  CONSTRAINT bids_moderation_valid CHECK (moderation IN ('pending', 'approved', 'rejected'))
);
CREATE INDEX IF NOT EXISTS bids_hour_amount_idx ON bids (hour_id, amount_cents DESC, created_at ASC);
CREATE INDEX IF NOT EXISTS bids_user_idx ON bids (user_id, created_at DESC);

ALTER TABLE hours
  DROP CONSTRAINT IF EXISTS hours_winning_bid_fk;
ALTER TABLE hours
  ADD CONSTRAINT hours_winning_bid_fk
  FOREIGN KEY (winning_bid_id) REFERENCES bids(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------- payments

DO $$ BEGIN
  CREATE TYPE payment_status AS ENUM ('pending', 'paid', 'expired', 'failed', 'refunded');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS payments (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hour_id               bigint NOT NULL REFERENCES hours(id) ON DELETE CASCADE,
  bid_id                uuid NOT NULL REFERENCES bids(id) ON DELETE CASCADE,
  user_id               uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider              text NOT NULL DEFAULT 'polar',
  provider_checkout_id  text UNIQUE,
  provider_order_id     text,
  amount_cents          integer NOT NULL,
  fee_cents             integer NOT NULL DEFAULT 0,
  charity_cents         integer NOT NULL DEFAULT 0,
  status                payment_status NOT NULL DEFAULT 'pending',
  expires_at            timestamptz NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  paid_at               timestamptz,
  CONSTRAINT payments_amount_positive CHECK (amount_cents > 0)
);
-- At most one live payment attempt per bid.
CREATE UNIQUE INDEX IF NOT EXISTS payments_one_pending_per_bid
  ON payments (bid_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS payments_pending_expiry_idx
  ON payments (expires_at) WHERE status = 'pending';

-- Webhook replay/idempotency guard: a provider event id is processed at most
-- once, enforced by the primary key rather than by application logic.
CREATE TABLE IF NOT EXISTS webhook_events (
  provider     text NOT NULL,
  event_id     text NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  event_type   text,
  PRIMARY KEY (provider, event_id)
);

-- ------------------------------------------------------- abuse + forensics

-- Fixed-window counters. Keyed by a hash so raw IPs are not stored.
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket        text PRIMARY KEY,
  window_start  timestamptz NOT NULL,
  count         integer NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_limits_window_idx ON rate_limits (window_start);

-- Append-only record of every money- or access-relevant action.
CREATE TABLE IF NOT EXISTS audit_log (
  id        bigserial PRIMARY KEY,
  at        timestamptz NOT NULL DEFAULT now(),
  action    text NOT NULL,
  actor_id  uuid,
  subject   text,
  ip_hash   bytea,
  data      jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS audit_log_at_idx ON audit_log (at DESC);
CREATE INDEX IF NOT EXISTS audit_log_action_idx ON audit_log (action, at DESC);

COMMIT;
