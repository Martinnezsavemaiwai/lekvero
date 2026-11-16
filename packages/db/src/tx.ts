import type pg from 'pg';
import { dbFor } from './client';
import type { Db } from './client';

/** SQLSTATEs that are safe to retry: serialization_failure, deadlock_detected. */
const RETRYABLE = new Set(['40001', '40P01']);

export interface TxContext {
  readonly db: Db;
  readonly client: pg.PoolClient;
}

export interface TxOptions {
  /** Recorded in audit_log.actor via `SET LOCAL lekvero.actor`. */
  readonly actor: string;
  readonly maxAttempts?: number;
}

/**
 * Run `fn` in one READ COMMITTED transaction. Any error rolls back everything.
 * Retries only on serialization failures / deadlocks (the whole function is
 * re-run, so it must not have side effects outside the database).
 */
export async function withTransaction<T>(
  pool: pg.Pool,
  options: TxOptions,
  fn: (tx: TxContext) => Promise<T>,
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  for (let attempt = 1; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('lekvero.actor', $1, true)", [options.actor]);
      const result = await fn({ db: dbFor(client), client });
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      const code = sqlState(err);
      if (code && RETRYABLE.has(code) && attempt < maxAttempts) continue;
      throw err;
    } finally {
      client.release();
    }
  }
}

/** SQLSTATE of a pg error, also when wrapped by Drizzle (DrizzleQueryError.cause). */
export function sqlState(err: unknown): string | undefined {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = e?.code ?? e?.cause?.code;
  return typeof code === 'string' ? code : undefined;
}
