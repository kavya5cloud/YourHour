// src-api/health.ts
var REQUIRED = [
  "SITE_ORIGIN",
  "DATABASE_URL",
  "SECRET_KEY",
  "CRON_SECRET",
  "POLAR_ACCESS_TOKEN",
  "POLAR_WEBHOOK_SECRET",
  "POLAR_PRODUCT_ID",
  "RESEND_API_KEY",
  "EMAIL_FROM"
];
async function handler(req, res) {
  const present = {};
  const missing = [];
  for (const name of REQUIRED) {
    const value = process.env[name];
    const ok = typeof value === "string" && value.length > 0;
    present[name] = ok;
    if (!ok) missing.push(name);
  }
  const lengths = {
    SECRET_KEY: (process.env.SECRET_KEY ?? "").length,
    CRON_SECRET: (process.env.CRON_SECRET ?? "").length
  };
  let polar = null;
  if (new URL(req.url ?? "/", "http://x").searchParams.get("polar") === "1") {
    const base = "https://api.polar.sh";
    try {
      const response = await fetch(`${base}/v1/products/${process.env.POLAR_PRODUCT_ID}`, {
        headers: { Authorization: `Bearer ${process.env.POLAR_ACCESS_TOKEN}` },
        signal: AbortSignal.timeout(5e3)
      });
      polar = {
        base,
        status: response.status,
        ok: response.ok,
        detail: response.ok ? null : (await response.text()).slice(0, 200)
      };
    } catch (error) {
      polar = { base, error: error.message };
    }
  }
  res.statusCode = missing.length === 0 ? 200 : 503;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(
    JSON.stringify({
      ok: missing.length === 0,
      missing,
      present,
      lengths,
      nodeVersion: process.version,
      siteOriginScheme: (process.env.SITE_ORIGIN ?? "").split(":")[0] || null,
      polar
    })
  );
}
export {
  handler as default
};
