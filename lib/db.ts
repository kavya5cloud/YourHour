/**
 * Postgres access.
 *
 * Every statement in this codebase goes through `query`/`tx` with parameter
 * placeholders. There is no string interpolation of user input into SQL
 * anywhere -- that is the single rule that keeps injection off the table.
 */
import pg from 'pg';
import { env } from './env.ts';

const { Pool } = pg;

// Postgres returns bigint (int8) as a string to avoid precision loss. Hour ids
// are well inside the safe integer range, so parse them to numbers.
pg.types.setTypeParser(20, (value: string) => Number.parseInt(value, 10));

declare global {
  // eslint-disable-next-line no-var
  var __getYourHourPool: pg.Pool | undefined;
}

/**
 * One pool per warm serverless instance. `max` stays small because many
 * instances may be alive at once; point DATABASE_URL at a pooler (PgBouncer,
 * Neon/Supabase pooled endpoint) in production.
 */
function getPool(): pg.Pool {
  if (!globalThis.__getYourHourPool) {
    globalThis.__getYourHourPool = new Pool({
      connectionString: env.databaseUrl,
      max: 3,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 5_000,
      // Refuse to fall back to an unencrypted connection in production.
      ssl: env.isProduction ? { rejectUnauthorized: true } : undefined,
      // A stuck statement must not pin a serverless invocation open.
      statement_timeout: 8_000,
      query_timeout: 8_000,
    });
    globalThis.__getYourHourPool.on('error', (error) => {
      console.error('pg pool error', { message: error.message });
    });
  }
  return globalThis.__getYourHourPool;
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
): Promise<pg.QueryResult<T>> {
  return getPool().query<T>(text, params as unknown[]);
}

/**
 * Run `fn` inside a transaction, rolling back on any throw.
 *
 * Callers that mutate auction state must take a row lock (`SELECT ... FOR
 * UPDATE` on the hour) as their first statement, so concurrent bids on the same
 * hour serialise instead of racing.
 */
export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    // The rollover transaction calls the payment provider while holding a row
    // lock on the hour. These bounds make sure a hung network call or a crashed
    // invocation releases that lock instead of blocking every bid on the hour.
    await client.query(`SET LOCAL lock_timeout = '5s'`);
    await client.query(`SET LOCAL idle_in_transaction_session_timeout = '15s'`);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('rollback failed', { message: (rollbackError as Error).message });
    }
    throw error;
  } finally {
    client.release();
  }
}
