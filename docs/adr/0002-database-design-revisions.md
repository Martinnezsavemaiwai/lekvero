# ADR-0002: Database design revisions for M3

- Status: Accepted (approved by the project owner before M3)
- Date: 2026-11-16
- Supersedes parts of the original `docs/architecture/database-design.md`. The original version is preserved in Git history at commit `7f1d532`.

## Context

The database design was written before M2. Building the matching engine (ADR-0001) settled several facts that the original schema contradicted. During M3 review the owner also asked for:
- an explicit verification lifecycle,
- raw-payload integrity,
- concurrency guarantees,
- append-only behaviour enforced in the database,
- separate database roles,
- forward-only migrations.

## Decisions

### D1–D7: schema corrections

| # | Change | Reason |
|---|---|---|
| D1 | Removed `prize_structure.valid_from/valid_to` and the exclusion constraint. Added *informational* `first_observed_draw` / `last_observed_draw` | Structure is inferred from the draw's data. The changeover date is unverified |
| D2 | Removed `prize_structure_rule.expected_amount` | Amounts are per-draw data, never fixed values |
| D3 | `result_prize.amount_baht` is nullable | Unknown/unverified amounts (e.g. legacy draws) are `NULL`, never guessed |
| D4 | `prize_structure_id` moved from `draw` to `result_set` | A draw may exist before any result. The structure belongs to the result data |
| D5 | No `UNIQUE(draw_id, content_hash)` | Must allow A → B → A. "Unchanged" means equal to the **current** version, or to any version **not superseded by a correction**, checked under the draw lock. *Found during M3 testing:* the first rule ("current or latest") created duplicates when imports were serialised as X, Y, X; the regression test is in `concurrency.test.ts` |
| D6 | Expected counts are checked in the application validator and recorded as `verification_check` rows. The DB enforces only rules with no exceptions | Boundary draws (first = 000000/999999) may legitimately differ, and M2 accepts them with a warning |
| D7 | `raw_payload.body_bytes bytea` holds the exact bytes. `body_json jsonb` is a parsed copy for querying | `jsonb` re-serialises, so the original bytes and their hash could not be reproduced |

### Verification lifecycle (new)

`verification_status`: `PENDING → VALIDATED → VERIFIED`, with `QUARANTINED` and `REJECTED` branches. This is enforced by the `result_set_guard` trigger:

| Transition | Required evidence in `verification_check` |
|---|---|
| PENDING → VALIDATED | ≥1 `VALIDATION` PASS/WARN, no `VALIDATION` FAIL |
| PENDING/VALIDATED → QUARANTINED | non-empty `status_reason` |
| VALIDATED → VERIFIED | the above, plus ≥1 `OFFICIAL_EVIDENCE` PASS (with `evidence_ref`) and **no** non-PASS official evidence |
| QUARANTINED → VERIFIED | the same, plus ≥1 `OPERATOR_REVIEW` PASS |
| PENDING/VALIDATED/QUARANTINED → REJECTED | non-empty `status_reason` |
| VERIFIED, REJECTED | terminal |

**Schema validity alone can never produce VERIFIED.**

- **What counts as `OFFICIAL_EVIDENCE`:** a comparison against an official GLO artefact, such as GLO's checker endpoint, the draw PDF, or (locally) archived GLO checker responses.
- **Pointer rule:** only VERIFIED sets can become `draw.current_result_set_id`.

### Other decisions

- **Same-draw integrity is declarative.** `draw (id, current_result_set_id)` and `correction (draw_id, from/to)` reference `result_set (draw_id, id)`. The pointer FK is **not deferrable**: the import order (draw → result_set → pointer) never needs deferral, and an immediate FK fails earlier. This is a deviation from the original doc, which proposed a deferrable FK.
- **Result contents are frozen after PENDING.** Prize rows, numbers and VALIDATION checks can only be added while their result set is PENDING. Categories must belong to the result set's prize structure.
- **Pointer changes need a correction.** Moving an existing pointer requires a `correction` row (from the current set to the new VERIFIED set) in the same transaction. The pointer can never be unset.
- **Append-only, at two layers:**
  - *Privileges:* runtime roles have no DELETE or TRUNCATE, and UPDATE only on lifecycle/pointer columns.
  - *Triggers:* these also bind the table owner.
  - *Limitation:* a superuser or the table owner can still `ALTER TABLE … DISABLE TRIGGER`. That is an operational control (see the runbook), not something the schema can prevent.
- **Audit trail.** `audit_log` is written only by a `SECURITY DEFINER` trigger, so runtime roles cannot insert into it or forge it. It records the application actor (`SET LOCAL lekvero.actor`) and the database login role.
- **Database roles:**
  - `lekvero_reader` (API): SELECT on published/result tables only. It cannot read raw payloads, import runs or the audit log.
  - `lekvero_writer` (ingestion): SELECT, INSERT, and column-limited UPDATE.
  - **Migration owner:** owns all objects.
  - Group roles are cluster-level and created by `db:bootstrap-roles`, not by migrations. Migration `0003` fails loudly if they are missing.
- **Raw payload safety:**
  - exact bytes are stored, with `CHECK (sha256 = sha256(body_bytes))`;
  - size is capped at 1 MiB (CHECK, and also enforced in the application);
  - response headers are allow-listed, with a CHECK forbidding `set-cookie`, `cookie`, `authorization`, `proxy-authorization` and `x-api-key`;
  - request parameters with credential-like keys are refused.
- **Concurrency.** Each import is one READ COMMITTED transaction that locks the draw row (`SELECT … FOR UPDATE`) and allocates `max(version)+1`. Versions are contiguous; a rolled-back import allocates nothing. Serialization failures and deadlocks are retried (up to 3 attempts).
- **Migrations:**
  - forward-only;
  - drizzle-kit-generated SQL plus hand-written SQL;
  - applied explicitly with `pnpm db:migrate`, never on app startup;
  - checked by `pnpm db:verify-migrations` (journal consistency, checksums of recorded migrations, no destructive statements, no schema drift).
- **PostgreSQL 17** for local development and CI. The production provider is deliberately undecided, and nothing here assumes provider-specific features. `sha256()` and `jsonb ?|` are core PostgreSQL.
- **Driver:** `pg` (node-postgres) with Drizzle ORM 0.45.

## Consequences

- Ingestion (M4/M5) must supply official evidence before anything is published.
- Operators need the runbook (`docs/runbooks/database.md`) for corrections, rejection and recovery.
- Fixture seeding is restricted to `LEKVERO_ENV=local|test` on a loopback host until GLO licensing is clarified.
