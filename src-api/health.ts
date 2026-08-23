/**
 * GET /api/health
 *
 * Reports which required environment variables are present, and nothing else.
 *
 * Deliberately imports nothing from `lib/`. Every other route fails at module
 * load when a secret is missing, which makes them all return an identical
 * opaque 500 -- useless for working out which one is absent. This route has no
 * such import, so it answers even when the rest of the deployment cannot.
 *
 * It exposes booleans and variable names only, never a value. The names are
 * already public in `.env.example`, so this reveals nothing a reader of the
 * repository does not already know. Delete it once the deployment is healthy.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

const REQUIRED = [
  'SITE_ORIGIN',
  'DATABASE_URL',
  'SECRET_KEY',
  'CRON_SECRET',
  'POLAR_ACCESS_TOKEN',
  'POLAR_WEBHOOK_SECRET',
  'POLAR_PRODUCT_ID',
  'RESEND_API_KEY',
  'EMAIL_FROM',
] as const;

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const present: Record<string, boolean> = {};
  const missing: string[] = [];
  for (const name of REQUIRED) {
    const value = process.env[name];
    const ok = typeof value === 'string' && value.length > 0;
    present[name] = ok;
    if (!ok) missing.push(name);
  }

  // Length only -- enough to catch a secret that is set but too short to pass
  // validation, without disclosing any part of it.
  const lengths = {
    SECRET_KEY: (process.env.SECRET_KEY ?? '').length,
    CRON_SECRET: (process.env.CRON_SECRET ?? '').length,
  };

  // ?polar=1 asks Polar whether our credentials work, from inside the
  // deployment. It only reads the product, never creates anything, and reports
  // the status code and Polar's own message -- no credential is echoed back.
  let polar: Record<string, unknown> | null = null;
  if (new URL(req.url ?? '/', 'http://x').searchParams.get('polar') === '1') {
    const base = process.env.POLAR_API_BASE || 'https://api.polar.sh';
    try {
      const response = await fetch(`${base}/v1/products/${process.env.POLAR_PRODUCT_ID}`, {
        headers: { Authorization: `Bearer ${process.env.POLAR_ACCESS_TOKEN}` },
        signal: AbortSignal.timeout(5_000),
      });
      polar = {
        base,
        status: response.status,
        ok: response.ok,
        detail: response.ok ? null : (await response.text()).slice(0, 200),
      };
    } catch (error) {
      polar = { base, error: (error as Error).message };
    }
  }

  res.statusCode = missing.length === 0 ? 200 : 503;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(
    JSON.stringify({
      ok: missing.length === 0,
      missing,
      present,
      lengths,
      nodeVersion: process.version,
      siteOriginScheme: (process.env.SITE_ORIGIN ?? '').split(':')[0] || null,
      polar,
    }),
  );
}
