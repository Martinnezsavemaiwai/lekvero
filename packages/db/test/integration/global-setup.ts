import { randomBytes } from 'node:crypto';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { bootstrapRoles } from '../../src/roles';
import { runMigrations } from '../../src/migrate';
import { urlFor } from './urls';
import type { ItContext } from './urls';

declare module 'vitest' {
  export interface ProvidedContext {
    lekvero: ItContext;
  }
}

export default async function setup(project: TestProject) {
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) {
    throw new Error(
      'DATABASE_URL is required for DB integration tests (admin connection to PostgreSQL 17). See README.',
    );
  }
  const suffix = randomBytes(4).toString('hex');
  // Random per-run passwords: no database credentials live in the repository.
  const pw = () => randomBytes(24).toString('base64url');
  const ctx: ItContext = {
    adminUrl,
    suffix,
    template: `lekvero_it_${suffix}_tpl`,
    roles: {
      owner: { name: 'lekvero_it_migrator', password: pw() },
      writer: { name: 'lekvero_it_ingest', password: pw() },
      reader: { name: 'lekvero_it_api', password: pw() },
    },
  };

  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    const { rows } = await admin.query<{ v: string }>(
      "SELECT current_setting('server_version_num') AS v",
    );
    if (Number(rows[0]!.v) < 170000) throw new Error(`PostgreSQL 17+ required, got ${rows[0]!.v}`);
    await bootstrapRoles(admin, [
      { ...ctx.roles.owner, memberOf: null },
      { ...ctx.roles.writer, memberOf: 'writer' },
      { ...ctx.roles.reader, memberOf: 'reader' },
    ]);
    await admin.query(`CREATE DATABASE ${ctx.template} OWNER ${ctx.roles.owner.name}`);
  } finally {
    await admin.end();
  }
  // Migrations run as the migration OWNER, exactly like production would.
  await runMigrations(urlFor(adminUrl, ctx.roles.owner, ctx.template));
  project.provide('lekvero', ctx);

  return async () => {
    const a = new pg.Client({ connectionString: adminUrl });
    await a.connect();
    try {
      const { rows: dbs } = await a.query<{ datname: string }>(
        'SELECT datname FROM pg_database WHERE datname LIKE $1',
        [`lekvero_it_${suffix}_%`],
      );
      for (const { datname } of dbs)
        await a.query(`DROP DATABASE ${a.escapeIdentifier(datname)} WITH (FORCE)`);
    } finally {
      await a.end();
    }
  };
}
