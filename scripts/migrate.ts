/**
 * Applies db/schema.sql.
 *
 * The schema is written to be idempotent (IF NOT EXISTS everywhere, enum
 * creation guarded), so running this against an existing database is safe and
 * is the intended way to pick up additions.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(here, '..', 'db', 'schema.sql'), 'utf8');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const client = new pg.Client({
  connectionString,
  ssl: connectionString.includes('sslmode=require') ? { rejectUnauthorized: true } : undefined,
});

try {
  await client.connect();
  await client.query(sql);
  console.log('Schema applied.');
} catch (error) {
  console.error('Migration failed:', (error as Error).message);
  process.exitCode = 1;
} finally {
  await client.end();
}
