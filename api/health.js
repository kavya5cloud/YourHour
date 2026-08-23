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
function handler(_req, res) {
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
      siteOriginScheme: (process.env.SITE_ORIGIN ?? "").split(":")[0] || null
    })
  );
}
export {
  handler as default
};
