/**
 * Fixed-window rate limiting, counted in Postgres.
 *
 * The counter lives in the database rather than in process memory because
 * serverless invocations are independent -- an in-memory limiter would reset
 * every cold start and be trivially bypassed by fanning requests across
 * instances.
 *
 * The whole increment is a single atomic upsert, so concurrent requests cannot
 * interleave a read and a write to slip past the limit.
 */
import { query } from './db.ts';
import { bucketKey } from './crypto.ts';
import { tooMany } from './http.ts';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * Count one hit against `scope:identifier`.
 *
 * @param scope       logical limiter name, e.g. 'bid:user'
 * @param identifier  the subject being limited (user id, IP, email)
 * @param limit       hits permitted per window
 * @param windowSeconds  window length
 */
export async function consume(
  scope: string,
  identifier: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const now = Date.now();
  const windowMs = windowSeconds * 1000;
  const windowStart = new Date(Math.floor(now / windowMs) * windowMs);
  const key = bucketKey(scope, identifier);

  const { rows } = await query<{ count: number }>(
    `INSERT INTO rate_limits (bucket, window_start, count)
     VALUES ($1, $2, 1)
     ON CONFLICT (bucket) DO UPDATE
       SET count = CASE WHEN rate_limits.window_start = $2 THEN rate_limits.count + 1 ELSE 1 END,
           window_start = $2
     RETURNING count`,
    [key, windowStart],
  );

  const count = rows[0]?.count ?? 1;
  const retryAfterSeconds = Math.max(1, Math.ceil((windowStart.getTime() + windowMs - now) / 1000));
  return {
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
    retryAfterSeconds,
  };
}

/** Consume a hit and throw a 429 if the limit is exceeded. */
export async function enforce(
  scope: string,
  identifier: string | null,
  limit: number,
  windowSeconds: number,
  message = 'Too many requests. Try again shortly.',
): Promise<void> {
  // A missing identifier must not silently disable the limiter.
  const subject = identifier ?? 'unknown';
  const result = await consume(scope, subject, limit, windowSeconds);
  if (!result.allowed) throw tooMany(message, result.retryAfterSeconds);
}

/** Housekeeping for the scheduled job: drop windows nobody will read again. */
export async function pruneRateLimits(): Promise<number> {
  const { rowCount } = await query(
    `DELETE FROM rate_limits WHERE window_start < now() - interval '2 hours'`,
  );
  return rowCount ?? 0;
}
