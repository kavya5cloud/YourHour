/**
 * HTTP plumbing: security headers, safe body reading, CSRF-relevant origin
 * checks, uniform error responses.
 *
 * Two habits are enforced here rather than left to each handler:
 *  - Responses never carry internal error detail. Failures get a short public
 *    message plus a correlation id that is written to the server log.
 *  - Request bodies are size-capped before parsing, so a large upload cannot
 *    burn memory or invocation time.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { env, siteUrl } from './env.ts';

export interface ApiRequest extends IncomingMessage {
  /** Populated by the platform's body parser when it is enabled. */
  body?: unknown;
  query?: Record<string, string | string[] | undefined>;
  cookies?: Record<string, string>;
}

export interface ApiResponse extends ServerResponse {
  status?: (code: number) => ApiResponse;
  json?: (body: unknown) => void;
}

/** Largest JSON request body we will read, in bytes. */
const MAX_BODY_BYTES = 16 * 1024;

/**
 * An error whose message is safe to show a client. Anything else that escapes a
 * handler is reported as a generic 500.
 */
export class HttpError extends Error {
  // Declared as plain fields rather than constructor parameter properties:
  // Node's type-stripping runtime does not support the latter.
  readonly status: number;
  readonly code: string;
  readonly headers: Record<string, string>;

  constructor(status: number, message: string, code = 'error', headers: Record<string, string> = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

export const badRequest = (message: string, code = 'bad_request') => new HttpError(400, message, code);
export const unauthorized = (message = 'Sign in to continue.') => new HttpError(401, message, 'unauthorized');
export const forbidden = (message = 'Not allowed.') => new HttpError(403, message, 'forbidden');
export const notFound = (message = 'Not found.') => new HttpError(404, message, 'not_found');
export const conflict = (message: string, code = 'conflict') => new HttpError(409, message, code);
export const tooMany = (message: string, retryAfterSeconds: number) =>
  new HttpError(429, message, 'rate_limited', { 'Retry-After': String(retryAfterSeconds) });

/**
 * Headers applied to every API response. The static assets get their own set
 * from the platform config; these protect the JSON endpoints.
 */
export function applySecurityHeaders(res: ApiResponse): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=(), payment=(), usb=()');
  // API responses are per-user and must never land in a shared cache.
  res.setHeader('Cache-Control', 'no-store, private');
  if (env.isProduction) {
    res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  }
}

export function sendJson(res: ApiResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  applySecurityHeaders(res);
  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.statusCode = status;
  res.end(JSON.stringify(body));
}

/** Read the exact bytes the client sent. Required for webhook signatures. */
export function readRawBody(req: ApiRequest): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'Request body too large.', 'payload_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => reject(new HttpError(400, 'Could not read request body.', 'bad_body')));
  });
}

/** Parse a JSON body into a plain object, rejecting anything else. */
export async function readJsonBody(req: ApiRequest): Promise<Record<string, unknown>> {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'object' && !Array.isArray(req.body)) {
      return req.body as Record<string, unknown>;
    }
    throw badRequest('Expected a JSON object.');
  }
  const raw = await readRawBody(req);
  if (raw.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    throw badRequest('Body is not valid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw badRequest('Expected a JSON object.');
  }
  // Strip prototype-polluting keys before the object reaches any handler.
  const safe: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(parsed)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    safe[key] = value;
  }
  return safe;
}

/**
 * The client IP, taken only from headers the platform itself sets.
 *
 * `x-forwarded-for` is deliberately not trusted first: a client can prepend
 * arbitrary entries to it, which would let an attacker forge a fresh identity
 * for every rate-limited request.
 */
export function clientIp(req: ApiRequest): string | null {
  const header = (name: string): string | null => {
    const value = req.headers[name];
    const single = Array.isArray(value) ? value[0] : value;
    return single ? single.split(',')[0]!.trim() : null;
  };
  return header('x-vercel-forwarded-for') ?? header('x-real-ip') ?? req.socket?.remoteAddress ?? null;
}

/**
 * Reject cross-site state-changing requests.
 *
 * This is defence in depth alongside SameSite cookies: browsers that mishandle
 * SameSite, and any future cross-origin surface, are still covered because a
 * request must positively prove it came from our own origin.
 */
export function requireSameOrigin(req: ApiRequest): void {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin !== '') {
    if (origin !== siteUrl.origin) throw forbidden('Cross-origin request rejected.');
    return;
  }
  // No Origin header: fall back to Referer, and refuse if neither is present.
  const referer = req.headers.referer;
  if (typeof referer === 'string' && referer !== '') {
    try {
      if (new URL(referer).origin === siteUrl.origin) return;
    } catch {
      /* fall through to rejection */
    }
  }
  throw forbidden('Could not verify request origin.');
}

export function requireMethod(req: ApiRequest, ...allowed: string[]): void {
  if (!allowed.includes(req.method ?? '')) {
    throw new HttpError(405, 'Method not allowed.', 'method_not_allowed', { Allow: allowed.join(', ') });
  }
}

type Handler = (req: ApiRequest, res: ApiResponse) => Promise<void>;

/**
 * Wrap a handler so that no exception ever escapes as a stack trace, and every
 * response carries the standard security headers.
 */
export function withErrorHandling(handler: Handler): Handler {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      if (error instanceof HttpError) {
        sendJson(res, error.status, { error: error.code, message: error.message }, error.headers);
        return;
      }
      // Unexpected: log the detail server-side, return only a correlation id.
      const incidentId = randomUUID();
      console.error('unhandled error', {
        incidentId,
        path: req.url,
        method: req.method,
        message: (error as Error)?.message,
        stack: (error as Error)?.stack,
      });
      sendJson(res, 500, {
        error: 'internal_error',
        message: 'Something went wrong on our end.',
        incidentId,
      });
    }
  };
}
