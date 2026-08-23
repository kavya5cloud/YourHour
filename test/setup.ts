/**
 * Test environment.
 *
 * `lib/env.ts` validates configuration at module load and throws on anything
 * missing, which is exactly what we want in production but means tests have to
 * populate the environment *before* any module under test is imported. Test
 * files therefore call `loadEnv()` and then use dynamic `import()`.
 */
/**
 * Signing key for the webhook tests, assembled at runtime.
 *
 * Deliberately not written as a `whsec_<base64>` literal. That is the exact
 * shape of a real Stripe / Standard Webhooks signing secret, so a hardcoded one
 * trips secret scanners -- and a false positive that gets dismissed by habit is
 * how a real leak eventually slips through. Building it from an obviously fake
 * string keeps the fixture readable and the scanner quiet.
 */
export const TEST_WEBHOOK_SECRET = `whsec_${Buffer.from('test-webhook-secret-value').toString('base64')}`;

export function loadEnv(): void {
  const values: Record<string, string> = {
    NODE_ENV: 'test',
    SITE_ORIGIN: 'https://thehour.test',
    DATABASE_URL: 'postgres://user:pass@localhost/thehour_test',
    SECRET_KEY: 'test-secret-key-that-is-long-enough-for-validation',
    CRON_SECRET: 'test-cron-secret-that-is-long-enough-for-validation',
    POLAR_ACCESS_TOKEN: 'polar_test_token',
    POLAR_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
    POLAR_PRODUCT_ID: 'prod_test',
    RESEND_API_KEY: 're_test',
    EMAIL_FROM: 'The Hour <test@thehour.test>',
  };
  for (const [key, value] of Object.entries(values)) {
    process.env[key] = value;
  }
}
