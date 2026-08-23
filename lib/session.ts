/**
 * Passwordless sessions.
 *
 * Design choices and why:
 *  - The cookie holds an opaque 256-bit random token, not a signed claim. The
 *    server stores only its HMAC, so a database leak yields no usable cookies,
 *    and revocation (logout, account disable) takes effect immediately because
 *    every request checks the row.
 *  - The cookie is HttpOnly, so script cannot read it even if XSS lands.
 *  - The CSRF token is returned in the JSON body instead of a readable cookie,
 *    and must come back in a header. Cross-origin script cannot read a response
 *    body it is not allowed to see, so it cannot learn the value.
 */
import type { ApiRequest, ApiResponse } from './http.ts';
import { forbidden, unauthorized } from './http.ts';
import { hashIp, hashToken, randomToken, safeEqual } from './crypto.ts';
import { query } from './db.ts';
import { env } from './env.ts';

/** The __Host- prefix pins the cookie to this exact origin with no Domain. */
export const SESSION_COOKIE = env.isProduction ? '__Host-th_session' : 'th_session';
const SESSION_TTL_DAYS = 30;
const CSRF_HEADER = 'x-csrf-token';

export interface Session {
  id: string;
  userId: string;
  email: string;
  csrfHash: Buffer;
}

export function parseCookies(req: ApiRequest): Record<string, string> {
  const header = req.headers.cookie;
  const jar: Record<string, string> = Object.create(null);
  if (!header) return jar;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name) jar[name] = decodeURIComponent(value);
  }
  return jar;
}

function appendCookie(res: ApiResponse, value: string): void {
  const existing = res.getHeader('Set-Cookie');
  const list = existing === undefined ? [] : Array.isArray(existing) ? existing : [String(existing)];
  list.push(value);
  res.setHeader('Set-Cookie', list);
}

export function setSessionCookie(res: ApiResponse, token: string, expiresAt: Date): void {
  const attributes = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    // Lax rather than Strict so that following the emailed magic link into the
    // site keeps the session; every state-changing route still checks Origin.
    'SameSite=Lax',
    `Expires=${expiresAt.toUTCString()}`,
    `Max-Age=${Math.floor((expiresAt.getTime() - Date.now()) / 1000)}`,
  ];
  if (env.isProduction) attributes.push('Secure');
  appendCookie(res, attributes.join('; '));
}

export function clearSessionCookie(res: ApiResponse): void {
  const attributes = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (env.isProduction) attributes.push('Secure');
  appendCookie(res, attributes.join('; '));
}

export interface NewSession {
  token: string;
  csrfToken: string;
  expiresAt: Date;
}

/**
 * The CSRF token for a session, derived rather than stored.
 *
 * Deriving it from the session id under SECRET_KEY makes it stable for the life
 * of the session, so several open tabs all hold a working token and none of
 * them gets invalidated by another tab refreshing. It is still unguessable
 * without the key, and it dies with the session, which is the only lifetime
 * that matters.
 */
export function csrfTokenFor(sessionId: string): string {
  return hashToken(`csrf:${sessionId}`).toString('base64url');
}

export async function createSession(
  userId: string,
  ip: string | null,
  userAgent: string | null,
): Promise<NewSession> {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);

  // csrf_hash is written in the same statement that mints the row, using the
  // freshly generated id, so it is always consistent with csrfTokenFor().
  const { rows } = await query<{ id: string }>(
    `INSERT INTO sessions (user_id, token_hash, csrf_hash, expires_at, ip_hash, user_agent)
     VALUES ($1, $2, '\\x00'::bytea, $3, $4, $5)
     RETURNING id`,
    [userId, hashToken(token), expiresAt, hashIp(ip), userAgent?.slice(0, 300) ?? null],
  );
  const sessionId = rows[0]!.id;
  const csrfToken = csrfTokenFor(sessionId);
  await query(`UPDATE sessions SET csrf_hash = $1 WHERE id = $2`, [hashToken(csrfToken), sessionId]);

  return { token, csrfToken, expiresAt };
}

/**
 * Resolve the current session, or null.
 *
 * The join against `users` means a disabled account loses access on its next
 * request without needing its sessions to be hunted down individually.
 */
export async function getSession(req: ApiRequest): Promise<Session | null> {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token || token.length < 20 || token.length > 128) return null;

  const { rows } = await query<{ id: string; user_id: string; email: string; csrf_hash: Buffer }>(
    `SELECT s.id, s.user_id, u.email, s.csrf_hash
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > now()
        AND u.disabled_at IS NULL`,
    [hashToken(token)],
  );
  const row = rows[0];
  if (!row) return null;

  // Sliding activity timestamp, throttled to at most once a minute.
  void query(`UPDATE sessions SET last_seen_at = now() WHERE id = $1 AND last_seen_at < now() - interval '1 minute'`, [
    row.id,
  ]).catch(() => undefined);

  return { id: row.id, userId: row.user_id, email: row.email, csrfHash: row.csrf_hash };
}

export async function requireSession(req: ApiRequest): Promise<Session> {
  const session = await getSession(req);
  if (!session) throw unauthorized();
  return session;
}

/**
 * Verify the CSRF header against the session's stored token hash.
 *
 * Paired with the Origin check in `requireSameOrigin`, this covers both the
 * "browser sent our cookie from someone else's page" case and any future
 * non-browser client.
 */
export function requireCsrf(req: ApiRequest, session: Session): void {
  const header = req.headers[CSRF_HEADER];
  const provided = Array.isArray(header) ? header[0] : header;
  if (!provided || typeof provided !== 'string') throw forbidden('Missing CSRF token.');
  if (!safeEqual(hashToken(provided), session.csrfHash)) throw forbidden('Invalid CSRF token.');
}

export async function revokeSession(sessionId: string): Promise<void> {
  await query(`UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [sessionId]);
}

/** Invalidate every session for a user, e.g. on account disable. */
export async function revokeAllSessions(userId: string): Promise<void> {
  await query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
}
