# Database runbook

Scope: PostgreSQL 17 database for Lekvero (M3). There is no production deployment yet: no hosting provider has been chosen and nothing is deployed publicly. Steps marked **(future)** apply once one exists.

## 1. First-time setup (any environment)

The order matters. Every step is explicit; **nothing runs on application startup.**

| Step | Who | Command | Connection |
|---|---|---|---|
| 1. Create roles and database | DB admin | `pnpm --filter @lekvero/db db:bootstrap-roles` | `ADMIN_DATABASE_URL` (superuser or CREATEROLE) |
| 2. Apply migrations | migration owner | `pnpm --filter @lekvero/db db:migrate` | `MIGRATION_DATABASE_URL` |
| 3. (local/test only) Load archived fixtures | ingestion role | `LEKVERO_ENV=local pnpm --filter @lekvero/db db:seed:fixtures` | `INGEST_DATABASE_URL` (loopback host only) |

- **What `db:bootstrap-roles` does:** it is idempotent. It creates the NOLOGIN groups `lekvero_reader` and `lekvero_writer`. If the matching password variables are set, it also creates or updates the logins `lekvero_migrator` (owner), `lekvero_ingest` (writer) and `lekvero_api` (reader), creates `LEKVERO_DB_NAME` owned by `lekvero_migrator`, and revokes PUBLIC CONNECT.
- **Passwords:** at least 16 characters, never committed. Locally, use `.env`. **(future)** In hosted environments, use the platform's secret manager.

### Local quick start
```bash
cp .env.example .env            # then replace every change-me value
docker compose up -d postgres   # PostgreSQL 17 on 127.0.0.1:5432
set -a; . ./.env; set +a
pnpm --filter @lekvero/db db:bootstrap-roles
pnpm --filter @lekvero/db db:migrate
pnpm --filter @lekvero/db db:seed:fixtures   # optional, local only
pnpm test:db                                 # integration tests (uses DATABASE_URL = admin)
```

## 2. Changing the schema (forward-only)

1. Edit `packages/db/src/schema.ts`, then run `pnpm --filter @lekvero/db db:generate --name <change>`. For triggers, grants or data, use `pnpm --filter @lekvero/db exec drizzle-kit generate --custom --name <change>` and write the SQL by hand.
2. **Never edit or delete a migration that has been recorded.** Fix mistakes with a new migration.
3. Prefer additive changes. When a change has to be destructive, use **expand → migrate → contract** across separate releases, with an explicit review. In M3, `db:verify-migrations` rejects any destructive statement.
4. Run `pnpm db:verify-migrations --record` **after review** to record the new migration's checksum, then run `pnpm db:verify-migrations` and `pnpm test:db`.
5. Each migration file should state its recovery approach in a header comment (see §3).

`pnpm db:verify-migrations` (also run in CI) checks:
- the journal matches the files;
- recorded migrations are unchanged (checksums);
- there are no destructive statements;
- `drizzle-kit check` passes;
- `src/schema.ts` has no drift from the committed SQL.

## 3. Recovery procedures

Not every migration can be safely reversed. Use the first case that applies.

| Situation | Procedure |
|---|---|
| A migration **failed** while being applied | Drizzle applies pending migrations in one transaction, so a failure rolls back completely and the database stays at the previous version. Fix with a **new** migration (or fix the unrecorded file if it was never applied anywhere) and re-run `db:migrate` |
| A migration **applied but was wrong**, and the change is additive | Write a forward-fix migration (for example, add the missing constraint or grant). Do not edit the old file |
| A migration applied and **lost or corrupted data** | **(future)** Restore from backup or point-in-time recovery to just before the migration, then deploy a corrected migration. Take a backup immediately before every production migration |
| Derived result tables are wrong but `raw_payload` is intact | Rebuild into a fresh database: run the bootstrap, migrate, then re-import each stored raw payload through `recordImport`. Raw bytes plus SHA-256 are the source of truth (verify with `verifyRawPayloadIntegrity`). Verification evidence has to be re-attached |
| Local or test database is in a bad state | Drop it and repeat §1. Never use this in a hosted environment |

**M3 migrations specifically:**
- `0000` creates the schema.
- `0001` adds triggers.
- `0002` adds reference data.
- `0003` adds grants.

They are all additive, on a new database. Recovery means dropping and recreating the database (local/test), or restoring from backup **(future)**. No down-migrations are provided, by design.

## 4. Operating the verification lifecycle

- **Publishing:** a result is published only when it is VERIFIED. Attach official evidence (`recordOfficialEvidence`, with an `evidenceRef` naming the GLO artefact), then call `verifyResultSet`. Never mark something verified "because the JSON parsed".
- **Corrections:** GLO changes a published draw. Ingestion stores it as a new QUARANTINED version. An operator then:
  1. compares it against official sources,
  2. records an `OPERATOR_REVIEW` PASS and `OFFICIAL_EVIDENCE` PASS,
  3. calls `verifyResultSet`,
  4. calls `approveCorrection` with a reason.

  Everything is audited.
- **Bad data:** call `rejectResultSet` with a reason. VERIFIED and REJECTED are terminal.
- **Audit:** `audit_log` is readable only by the owner and writer roles. It records the application actor (`lekvero.actor`) and the database login role.

## 5. Guardrails and incidents

- **Disabling triggers:** the table owner or a superuser can technically `ALTER TABLE … DISABLE TRIGGER`. **Never do this on a hosted database.** If it ever happens, treat it as an incident: record who, when and why, re-enable the triggers, and audit for changes made while they were off.
- **Role compromise:**
  - Rotate the affected login: `ALTER ROLE … PASSWORD …` via `db:bootstrap-roles` with a new password.
  - A leaked **reader** credential exposes only published or result data.
  - A leaked **writer** credential could insert new versions, but cannot delete or alter history, cannot forge audit rows, and cannot publish without evidence rows. Those rows would show up in the audit log with the writer's login.
- **Payload limits:** responses over 1 MiB are refused (application check and DB CHECK). Investigate any refusal as a possible upstream change.
