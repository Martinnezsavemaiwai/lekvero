-- 0003_role_grants (hand-written; drizzle-kit --custom)
-- Least-privilege grants for the runtime group roles. The roles themselves are
-- cluster-level objects created beforehand by `pnpm db:bootstrap-roles`
-- (docs/runbooks/database.md); this migration fails loudly if they are missing.
--
--   lekvero_reader : public API. SELECT on published/result tables only
--                    (no raw payloads, import runs or audit log).
--   lekvero_writer : ingestion. SELECT + INSERT; UPDATE only on lifecycle/pointer
--                    columns; no DELETE, no TRUNCATE, no audit_log writes.
--   migration owner: the role that runs migrations and owns the objects.
-- Recovery: additive migration on a new database (M3). Not reversible in place; recover by
-- dropping/recreating the database (local/test) or restoring a backup (hosted). See docs/runbooks/database.md §3.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lekvero_reader')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lekvero_writer') THEN
    RAISE EXCEPTION 'lekvero: roles lekvero_reader/lekvero_writer are missing. Run `pnpm db:bootstrap-roles` first (docs/runbooks/database.md).';
  END IF;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO lekvero_reader, lekvero_writer;
--> statement-breakpoint
GRANT SELECT ON source, prize_category, prize_structure, prize_structure_rule,
                draw, result_set, result_prize, prize_number, verification_check, correction
  TO lekvero_reader;
--> statement-breakpoint
GRANT SELECT ON ALL TABLES IN SCHEMA public TO lekvero_writer;
--> statement-breakpoint
GRANT INSERT ON import_run, raw_payload, draw, result_set, result_prize, prize_number,
                verification_check, correction
  TO lekvero_writer;
--> statement-breakpoint
GRANT UPDATE (status, finished_at, stats, error) ON import_run TO lekvero_writer;
--> statement-breakpoint
GRANT UPDATE (verification_status, status_reason, verified_at, verified_by) ON result_set TO lekvero_writer;
--> statement-breakpoint
GRANT UPDATE (current_result_set_id, status, updated_at) ON draw TO lekvero_writer;
