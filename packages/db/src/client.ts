import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema';

export type Db = NodePgDatabase<typeof schema>;

/**
 * Create a connection pool. Each runtime uses its own role-specific URL
 * (API → reader, ingestion → writer, migrations → owner); see .env.example.
 */
export function createPool(connectionString: string, applicationName = 'lekvero'): pg.Pool {
  return new pg.Pool({ connectionString, application_name: applicationName, max: 10 });
}

export function dbFor(client: pg.Pool | pg.PoolClient): Db {
  return drizzle(client, { schema });
}
