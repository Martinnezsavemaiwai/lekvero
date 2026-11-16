import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createPool, dbFor } from './client';

export const MIGRATIONS_FOLDER = resolve(dirname(fileURLToPath(import.meta.url)), '../migrations');

/**
 * Apply pending migrations as the MIGRATION OWNER. Explicit only: never call
 * this from application startup. Pending migrations run in one transaction.
 */
export async function runMigrations(ownerConnectionString: string): Promise<void> {
  const pool = createPool(ownerConnectionString, 'lekvero-migrate');
  try {
    await migrate(dbFor(pool), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await pool.end();
  }
}
