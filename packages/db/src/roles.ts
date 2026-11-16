import type pg from 'pg';

/** Group roles (NOLOGIN) that receive grants in migrations/0003_role_grants.sql. */
export const READER_ROLE = 'lekvero_reader';
export const WRITER_ROLE = 'lekvero_writer';

export interface LoginRole {
  readonly name: string;
  readonly password: string;
  /** Group to join; null for the migration owner (privileges come from ownership). */
  readonly memberOf: 'reader' | 'writer' | null;
}

const ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * Create the group roles (idempotent) and, optionally, login roles. Must be run
 * by an administrator (superuser or CREATEROLE). Cluster-level, so it is NOT a
 * migration; run it once per cluster before `db:migrate`.
 */
export async function bootstrapRoles(
  admin: pg.ClientBase,
  logins: readonly LoginRole[] = [],
): Promise<void> {
  for (const role of [READER_ROLE, WRITER_ROLE]) {
    const { rowCount } = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
    if (!rowCount) await admin.query(`CREATE ROLE ${role} NOLOGIN`);
  }
  for (const login of logins) {
    if (!ROLE_NAME.test(login.name)) throw new Error(`Invalid role name: ${login.name}`);
    if (login.password.length < 16)
      throw new Error(`Password for ${login.name} must be ≥16 characters`);
    const ident = admin.escapeIdentifier(login.name);
    const pw = admin.escapeLiteral(login.password);
    const { rowCount } = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [
      login.name,
    ]);
    await admin.query(
      rowCount
        ? `ALTER ROLE ${ident} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD ${pw}`
        : `CREATE ROLE ${ident} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD ${pw}`,
    );
    if (login.memberOf) {
      await admin.query(
        `GRANT ${login.memberOf === 'reader' ? READER_ROLE : WRITER_ROLE} TO ${ident}`,
      );
    }
  }
}
