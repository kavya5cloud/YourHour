/**
 * Cryptographic helpers.
 *
 * Rules applied throughout:
 *  - Secrets are compared in constant time, never with `===`.
 *  - Bearer-style tokens are stored only as keyed hashes, never in plaintext.
 *  - Randomness always comes from the CSPRNG.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from './env.ts';

/** URL-safe random token. 32 bytes = 256 bits of entropy. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Keyed hash of a token for storage. HMAC rather than a bare digest so that a
 * stolen database alone cannot be brute-forced against a dictionary of guesses
 * without also stealing SECRET_KEY.
 */
export function hashToken(token: string): Buffer {
  return createHmac('sha256', env.secretKey).update(token, 'utf8').digest();
}

/**
 * Pseudonymised IP, for rate limiting and abuse forensics without retaining
 * the address itself.
 */
export function hashIp(ip: string | null): Buffer | null {
  if (!ip) return null;
  return createHmac('sha256', env.secretKey).update(`ip:${ip}`, 'utf8').digest();
}

/** Stable, non-reversible bucket key for rate limiting. */
export function bucketKey(scope: string, identifier: string): string {
  return `${scope}:${createHmac('sha256', env.secretKey).update(identifier, 'utf8').digest('base64url')}`;
}

/** Constant-time comparison that does not leak length through early exit. */
export function safeEqual(a: Buffer | string, b: Buffer | string): boolean {
  const left = Buffer.isBuffer(a) ? a : Buffer.from(a, 'utf8');
  const right = Buffer.isBuffer(b) ? b : Buffer.from(b, 'utf8');
  // timingSafeEqual throws on length mismatch, which would itself leak length.
  // Hashing first gives both sides a fixed width.
  const leftDigest = createHmac('sha256', env.secretKey).update(left).digest();
  const rightDigest = createHmac('sha256', env.secretKey).update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}
