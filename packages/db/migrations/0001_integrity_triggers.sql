-- 0001_integrity_triggers (hand-written; drizzle-kit --custom)
-- Database-level guarantees that Drizzle cannot express. These apply to EVERY
-- role, including the migration owner (a superuser or table owner could still
-- disable triggers explicitly; runtime roles cannot — see ADR-0002).
--
--  1. Same-draw pointer FK (draw.current_result_set_id → result_set of the same draw)
--  2. Append-only tables (no UPDATE / DELETE / TRUNCATE)
--  3. result_set: immutable content + verification state machine with evidence rules
--  4. Result contents frozen after PENDING; categories must belong to the prize structure
--  5. draw: pointer rules (VERIFIED target, never unset, changes require a correction)
--  6. correction: must move away from the current version to a VERIFIED version
--  7. import_run: only RUNNING runs can change, identity columns immutable
--  8. Audit trail written by SECURITY DEFINER triggers (runtime roles cannot forge it)
-- Recovery: additive migration on a new database (M3). Not reversible in place; recover by
-- dropping/recreating the database (local/test) or restoring a backup (hosted). See docs/runbooks/database.md §3.

-- 1 ---------------------------------------------------------------------------
ALTER TABLE "draw" ADD CONSTRAINT "draw_current_result_set_fk"
  FOREIGN KEY ("id", "current_result_set_id") REFERENCES "result_set" ("draw_id", "id");
--> statement-breakpoint

-- 2 ---------------------------------------------------------------------------
CREATE FUNCTION lekvero_forbid_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'lekvero: % on % is not allowed (append-only)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint

DO $$
DECLARE t text;
BEGIN
  -- Fully append-only: no UPDATE, no DELETE.
  FOREACH t IN ARRAY ARRAY['raw_payload','result_prize','prize_number','verification_check','correction','audit_log'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION lekvero_forbid_change()', t || '_append_only', t);
  END LOOP;
  -- Rows never deleted (controlled UPDATEs are checked by dedicated triggers below).
  FOREACH t IN ARRAY ARRAY['result_set','draw','import_run'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION lekvero_forbid_change()', t || '_no_delete', t);
  END LOOP;
  -- No TRUNCATE on any data table.
  FOREACH t IN ARRAY ARRAY['raw_payload','result_prize','prize_number','verification_check','correction','audit_log','result_set','draw','import_run'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION lekvero_forbid_change()', t || '_no_truncate', t);
  END LOOP;
END;
$$;
--> statement-breakpoint

-- 3 ---------------------------------------------------------------------------
-- Verification lifecycle (see docs/architecture/database-design.md §Lifecycle):
--   PENDING     → VALIDATED | QUARANTINED | REJECTED
--   VALIDATED   → VERIFIED  | QUARANTINED | REJECTED
--   QUARANTINED → VERIFIED  | REJECTED
--   VERIFIED, REJECTED: terminal
-- Evidence required (rows in verification_check for this result set):
--   → VALIDATED : ≥1 VALIDATION PASS/WARN and no VALIDATION FAIL
--   → VERIFIED  : the above AND ≥1 OFFICIAL_EVIDENCE PASS and no OFFICIAL_EVIDENCE FAIL/WARN;
--                 from QUARANTINED additionally ≥1 OPERATOR_REVIEW PASS.
-- Schema validity alone can therefore never produce VERIFIED.
CREATE FUNCTION lekvero_result_set_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_ok int; v_fail int; e_ok int; e_bad int; r_ok int;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.verification_status <> 'PENDING' THEN
      RAISE EXCEPTION 'lekvero: result_set must be created as PENDING (got %)', NEW.verification_status
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.draw_id IS DISTINCT FROM OLD.draw_id
     OR NEW.version IS DISTINCT FROM OLD.version OR NEW.prize_structure_id IS DISTINCT FROM OLD.prize_structure_id
     OR NEW.raw_payload_id IS DISTINCT FROM OLD.raw_payload_id OR NEW.import_run_id IS DISTINCT FROM OLD.import_run_id
     OR NEW.content_hash IS DISTINCT FROM OLD.content_hash OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'lekvero: result_set % content is immutable', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.verification_status = OLD.verification_status THEN
    RAISE EXCEPTION 'lekvero: result_set % has no status change; lifecycle fields are immutable otherwise', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NOT (
       (OLD.verification_status = 'PENDING'     AND NEW.verification_status IN ('VALIDATED','QUARANTINED','REJECTED'))
    OR (OLD.verification_status = 'VALIDATED'   AND NEW.verification_status IN ('VERIFIED','QUARANTINED','REJECTED'))
    OR (OLD.verification_status = 'QUARANTINED' AND NEW.verification_status IN ('VERIFIED','REJECTED'))
  ) THEN
    RAISE EXCEPTION 'lekvero: illegal transition % → % for result_set %', OLD.verification_status, NEW.verification_status, OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT count(*) FILTER (WHERE check_kind = 'VALIDATION' AND outcome IN ('PASS','WARN')),
         count(*) FILTER (WHERE check_kind = 'VALIDATION' AND outcome = 'FAIL'),
         count(*) FILTER (WHERE check_kind = 'OFFICIAL_EVIDENCE' AND outcome = 'PASS'),
         count(*) FILTER (WHERE check_kind = 'OFFICIAL_EVIDENCE' AND outcome <> 'PASS'),
         count(*) FILTER (WHERE check_kind = 'OPERATOR_REVIEW' AND outcome = 'PASS')
    INTO v_ok, v_fail, e_ok, e_bad, r_ok
    FROM verification_check WHERE result_set_id = OLD.id;

  IF NEW.verification_status IN ('VALIDATED','VERIFIED') AND (v_ok = 0 OR v_fail > 0) THEN
    RAISE EXCEPTION 'lekvero: result_set % needs passing VALIDATION checks and no VALIDATION failures for %', OLD.id, NEW.verification_status
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.verification_status = 'VERIFIED' THEN
    IF e_ok = 0 OR e_bad > 0 THEN
      RAISE EXCEPTION 'lekvero: result_set % needs OFFICIAL_EVIDENCE PASS (and no non-PASS evidence) to become VERIFIED', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.verification_status = 'QUARANTINED' AND r_ok = 0 THEN
      RAISE EXCEPTION 'lekvero: quarantined result_set % needs an OPERATOR_REVIEW PASS to become VERIFIED', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER result_set_guard BEFORE INSERT OR UPDATE ON result_set
  FOR EACH ROW EXECUTE FUNCTION lekvero_result_set_guard();
--> statement-breakpoint

-- 4 ---------------------------------------------------------------------------
CREATE FUNCTION lekvero_result_content_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  rs_status verification_status; rs_structure smallint; cat_digits smallint;
BEGIN
  SELECT verification_status, prize_structure_id INTO rs_status, rs_structure
    FROM result_set WHERE id = NEW.result_set_id;
  IF rs_status IS DISTINCT FROM 'PENDING' THEN
    RAISE EXCEPTION 'lekvero: % rows can only be added while result_set % is PENDING (is %)', TG_TABLE_NAME, NEW.result_set_id, rs_status
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF TG_TABLE_NAME = 'result_prize' THEN
    IF NOT EXISTS (SELECT 1 FROM prize_structure_rule
                    WHERE prize_structure_id = rs_structure AND prize_category_id = NEW.prize_category_id
                      AND expected_count > 0) THEN
      RAISE EXCEPTION 'lekvero: prize category % is not part of prize structure % (result_set %)', NEW.prize_category_id, rs_structure, NEW.result_set_id
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF TG_TABLE_NAME = 'prize_number' THEN
    SELECT digits INTO cat_digits FROM prize_category WHERE id = NEW.prize_category_id;
    IF length(NEW.number) <> cat_digits THEN
      RAISE EXCEPTION 'lekvero: number "%" must have % digits for category %', NEW.number, cat_digits, NEW.prize_category_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER result_prize_content_guard BEFORE INSERT ON result_prize
  FOR EACH ROW EXECUTE FUNCTION lekvero_result_content_guard();
--> statement-breakpoint
CREATE TRIGGER prize_number_content_guard BEFORE INSERT ON prize_number
  FOR EACH ROW EXECUTE FUNCTION lekvero_result_content_guard();
--> statement-breakpoint

-- VALIDATION evidence describes the imported content, so it is only recorded while PENDING.
CREATE FUNCTION lekvero_verification_check_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE rs_status verification_status;
BEGIN
  SELECT verification_status INTO rs_status FROM result_set WHERE id = NEW.result_set_id;
  IF NEW.check_kind = 'VALIDATION' AND rs_status <> 'PENDING' THEN
    RAISE EXCEPTION 'lekvero: VALIDATION checks can only be recorded while result_set % is PENDING', NEW.result_set_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF rs_status IN ('VERIFIED','REJECTED') AND NEW.check_kind <> 'OFFICIAL_EVIDENCE' THEN
    RAISE EXCEPTION 'lekvero: result_set % is % (terminal); only further OFFICIAL_EVIDENCE may be appended', NEW.result_set_id, rs_status
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER verification_check_guard BEFORE INSERT ON verification_check
  FOR EACH ROW EXECUTE FUNCTION lekvero_verification_check_guard();
--> statement-breakpoint

-- 5 ---------------------------------------------------------------------------
CREATE FUNCTION lekvero_draw_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE target verification_status;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.current_result_set_id IS NOT NULL THEN
      RAISE EXCEPTION 'lekvero: a draw is created without a current result set' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.draw_date IS DISTINCT FROM OLD.draw_date
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'lekvero: draw % identity is immutable', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.current_result_set_id IS DISTINCT FROM OLD.current_result_set_id THEN
    IF NEW.current_result_set_id IS NULL THEN
      RAISE EXCEPTION 'lekvero: draw % current result set cannot be unset', OLD.id USING ERRCODE = 'restrict_violation';
    END IF;
    SELECT verification_status INTO target FROM result_set WHERE id = NEW.current_result_set_id;
    IF target IS DISTINCT FROM 'VERIFIED' THEN
      RAISE EXCEPTION 'lekvero: draw % can only point at a VERIFIED result set (% is %)', OLD.id, NEW.current_result_set_id, target
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.current_result_set_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM correction
          WHERE draw_id = OLD.id AND from_result_set_id = OLD.current_result_set_id
            AND to_result_set_id = NEW.current_result_set_id) THEN
      RAISE EXCEPTION 'lekvero: changing draw % from % to % requires a correction record', OLD.id, OLD.current_result_set_id, NEW.current_result_set_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER draw_guard BEFORE INSERT OR UPDATE ON draw
  FOR EACH ROW EXECUTE FUNCTION lekvero_draw_guard();
--> statement-breakpoint

-- 6 ---------------------------------------------------------------------------
CREATE FUNCTION lekvero_correction_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE cur bigint; target verification_status;
BEGIN
  SELECT current_result_set_id INTO cur FROM draw WHERE id = NEW.draw_id;
  IF cur IS DISTINCT FROM NEW.from_result_set_id THEN
    RAISE EXCEPTION 'lekvero: correction must start from the current result set of draw % (current %, given %)', NEW.draw_id, cur, NEW.from_result_set_id
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT verification_status INTO target FROM result_set WHERE id = NEW.to_result_set_id;
  IF target IS DISTINCT FROM 'VERIFIED' THEN
    RAISE EXCEPTION 'lekvero: correction target % must be VERIFIED (is %)', NEW.to_result_set_id, target
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER correction_guard BEFORE INSERT ON correction
  FOR EACH ROW EXECUTE FUNCTION lekvero_correction_guard();
--> statement-breakpoint

-- 7 ---------------------------------------------------------------------------
CREATE FUNCTION lekvero_import_run_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'RUNNING' THEN
    RAISE EXCEPTION 'lekvero: import_run % is % and can no longer change', OLD.id, OLD.status USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.source_id IS DISTINCT FROM OLD.source_id
     OR NEW.trigger IS DISTINCT FROM OLD.trigger OR NEW.started_at IS DISTINCT FROM OLD.started_at THEN
    RAISE EXCEPTION 'lekvero: import_run % identity is immutable', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER import_run_guard BEFORE UPDATE ON import_run
  FOR EACH ROW EXECUTE FUNCTION lekvero_import_run_guard();
--> statement-breakpoint

-- 8 ---------------------------------------------------------------------------
-- Actor = application-supplied `SET LOCAL lekvero.actor = '...'`, else the login role.
CREATE FUNCTION lekvero_audit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor text := coalesce(nullif(current_setting('lekvero.actor', true), ''), session_user);
  act text; ent text; eid text; b jsonb; a jsonb;
BEGIN
  IF TG_TABLE_NAME = 'result_set' THEN
    ent := 'result_set'; eid := NEW.id::text;
    a := jsonb_build_object('draw_id', NEW.draw_id, 'version', NEW.version,
           'status', NEW.verification_status, 'reason', NEW.status_reason,
           'verified_by', NEW.verified_by, 'content_hash', encode(NEW.content_hash, 'hex'));
    IF TG_OP = 'INSERT' THEN
      act := 'result_set.create';
    ELSE
      act := 'result_set.status'; b := jsonb_build_object('status', OLD.verification_status);
    END IF;
  ELSIF TG_TABLE_NAME = 'draw' THEN
    ent := 'draw'; eid := NEW.id::text;
    IF TG_OP = 'INSERT' THEN
      act := 'draw.create'; a := jsonb_build_object('draw_date', NEW.draw_date, 'status', NEW.status);
    ELSIF NEW.current_result_set_id IS DISTINCT FROM OLD.current_result_set_id THEN
      act := 'draw.set_current';
      b := jsonb_build_object('current_result_set_id', OLD.current_result_set_id, 'status', OLD.status);
      a := jsonb_build_object('current_result_set_id', NEW.current_result_set_id, 'status', NEW.status);
    ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
      act := 'draw.status'; b := jsonb_build_object('status', OLD.status); a := jsonb_build_object('status', NEW.status);
    ELSE
      RETURN NULL;
    END IF;
  ELSIF TG_TABLE_NAME = 'correction' THEN
    act := 'correction.create'; ent := 'correction'; eid := NEW.id::text;
    a := jsonb_build_object('draw_id', NEW.draw_id, 'from', NEW.from_result_set_id, 'to', NEW.to_result_set_id,
           'reason', NEW.reason, 'detected_by', NEW.detected_by, 'approved_by', NEW.approved_by);
  ELSIF TG_TABLE_NAME = 'raw_payload' THEN
    act := 'raw_payload.store'; ent := 'raw_payload'; eid := NEW.id::text;
    a := jsonb_build_object('endpoint', NEW.endpoint, 'sha256', encode(NEW.sha256, 'hex'),
           'byte_size', NEW.byte_size, 'provenance', NEW.provenance);
  ELSIF TG_TABLE_NAME = 'verification_check' THEN
    act := 'verification_check.create'; ent := 'result_set'; eid := NEW.result_set_id::text;
    a := jsonb_build_object('kind', NEW.check_kind, 'code', NEW.check_code, 'outcome', NEW.outcome,
           'evidence_ref', NEW.evidence_ref, 'performed_by', NEW.performed_by);
  END IF;
  INSERT INTO audit_log (actor, db_role, action, entity_type, entity_id, before, after)
    VALUES (actor, session_user, act, ent, eid, b, a);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION lekvero_audit() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER result_set_audit AFTER INSERT OR UPDATE ON result_set FOR EACH ROW EXECUTE FUNCTION lekvero_audit();
--> statement-breakpoint
CREATE TRIGGER draw_audit AFTER INSERT OR UPDATE ON draw FOR EACH ROW EXECUTE FUNCTION lekvero_audit();
--> statement-breakpoint
CREATE TRIGGER correction_audit AFTER INSERT ON correction FOR EACH ROW EXECUTE FUNCTION lekvero_audit();
--> statement-breakpoint
CREATE TRIGGER raw_payload_audit AFTER INSERT ON raw_payload FOR EACH ROW EXECUTE FUNCTION lekvero_audit();
--> statement-breakpoint
CREATE TRIGGER verification_check_audit AFTER INSERT ON verification_check FOR EACH ROW EXECUTE FUNCTION lekvero_audit();
