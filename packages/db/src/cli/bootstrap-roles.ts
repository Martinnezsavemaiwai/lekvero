// pnpm db:bootstrap-roles — ADMIN step, once per cluster, before db:migrate.
// Creates group roles and (if passwords are provided) the three login roles,
// plus the application database owned by the migration owner.
import pg from 'pg';
import { bootstrapRoles } from '../roles';
import type { LoginRole } from '../roles';
import { requireEnv } from './env';

const admin = new pg.Client({ connectionString: requireEnv('ADMIN_DATABASE_URL') });
await admin.connect();
try {
  const logins: LoginRole[] = [];
  const add = (name: string, env: string, memberOf: LoginRole['memberOf']) => {
    const password = process.env[env];
    if (password) logins.push({ name, password, memberOf });
  };
  add('lekvero_migrator', 'LEKVERO_MIGRATOR_DB_PASSWORD', null);
  add('lekvero_ingest', 'LEKVERO_INGEST_DB_PASSWORD', 'writer');
  add('lekvero_api', 'LEKVERO_API_DB_PASSWORD', 'reader');
  await bootstrapRoles(admin, logins);

  const dbName = process.env.LEKVERO_DB_NAME;
  if (dbName && logins.some((l) => l.name === 'lekvero_migrator')) {
    const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      dbName,
    ]);
    if (!rowCount) {
      await admin.query(`CREATE DATABASE ${admin.escapeIdentifier(dbName)} OWNER lekvero_migrator`);
    }
    await admin.query(`REVOKE ALL ON DATABASE ${admin.escapeIdentifier(dbName)} FROM PUBLIC`);
    await admin.query(
      `GRANT CONNECT ON DATABASE ${admin.escapeIdentifier(dbName)} TO lekvero_reader, lekvero_writer`,
    );
  }
  console.log(`Roles ready (${logins.map((l) => l.name).join(', ') || 'group roles only'}).`);
} finally {
  await admin.end();
}
