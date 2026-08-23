/**
 * Local development server.
 *
 * `vercel dev` needs an interactive login, so this stands in for it: it serves
 * `public/` statically and mounts the `api/` handlers on a real http.Server,
 * exactly as the API tests do. The handlers are plain Node request/response
 * functions, so nothing about them is faked here -- routing, headers, origin
 * and CSRF checks, and error shaping all run for real.
 *
 * Outbound Resend calls are printed to the terminal instead of sent, so the
 * sign-in and checkout links are visible without a mail provider.
 *
 * Not used in production; Vercel routes /api itself.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const PORT = Number(process.env.PORT ?? 3000);
const PUBLIC_DIR = new URL('../public/', import.meta.url).pathname;

// The app validates every secret at module load. Fill the ones a local demo
// does not exercise so it can boot without real credentials.
process.env.SITE_ORIGIN ??= `http://localhost:${PORT}`;
for (const [key, placeholder] of [
  ['RESEND_API_KEY', 're_local_dev_placeholder'],
  ['POLAR_WEBHOOK_SECRET', 'whsec_bG9jYWxfZGV2X3BsYWNlaG9sZGVy'],
  ['POLAR_ACCESS_TOKEN', 'polar_oat_local_dev_placeholder'],
  ['POLAR_PRODUCT_ID', '00000000-0000-0000-0000-000000000000'],
] as const) {
  if (!process.env[key] || process.env[key] === 'FILL_ME') process.env[key] = placeholder;
}

// Print emails rather than sending them. Everything else passes through.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  if (url.includes('resend.com')) {
    const parsed = JSON.parse(String(init?.body ?? '{}'));
    console.log(`\n  EMAIL -> ${parsed.to?.[0]}\n  ${parsed.subject}\n  ${String(parsed.text ?? '').split('\n')[0]}\n`);
    return new Response(JSON.stringify({ id: 'local' }), { status: 200 });
  }
  return realFetch(input as Parameters<typeof realFetch>[0], init);
}) as typeof fetch;

const routes: Record<string, string> = {
  '/api/state': '../api/state.ts',
  '/api/claim': '../api/claim.ts',
  '/api/moderation': '../api/moderation.ts',
  '/api/auth/me': '../api/auth/me.ts',
  '/api/auth/request-link': '../api/auth/request-link.ts',
  '/api/auth/verify': '../api/auth/verify.ts',
  '/api/auth/logout': '../api/auth/logout.ts',
  '/api/cron/rollover': '../api/cron/rollover.ts',
  '/api/webhooks/polar': '../api/webhooks/polar.ts',
};

const handlers = new Map<string, (req: never, res: never) => Promise<void>>();
for (const [path, specifier] of Object.entries(routes)) {
  handlers.set(path, (await import(specifier)).default);
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/** The headers vercel.json serves in production, so the demo is faithful. */
const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
  "font-src 'self'; connect-src 'self'; base-uri 'none'; object-src 'none'; " +
  "frame-ancestors 'none'; form-action 'none'";

const server = createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;

  const handler = handlers.get(path);
  if (handler) {
    void handler(req as never, res as never);
    return;
  }

  // Static. `normalize` plus the prefix check keeps `..` from escaping public/.
  const rel = path === '/' ? 'index.html' : path.replace(/^\/+/, '');
  const file = normalize(join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  readFile(file)
    .then((body) => {
      res.writeHead(200, {
        'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
        'Content-Security-Policy': CSP,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      });
      res.end(body);
    })
    .catch(() => res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'));
});

server.listen(PORT, () => console.log(`\n  GetYourHour dev server -> http://localhost:${PORT}\n`));
