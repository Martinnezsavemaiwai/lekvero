/**
 * Drizzle schema for Lekvero (M3). See docs/architecture/database-design.md
 * (revised by ADR-0002).
 *
 * Things Drizzle cannot express live in hand-written SQL migrations
 * (migrations/0001..0003): the deferrable draw → result_set pointer FK,
 * append-only / lifecycle / audit triggers, reference data and role grants.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  customType,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  varchar,
} from 'drizzle-orm/pg-core';

/** Maximum stored size of one raw upstream response (bytes). Mirrored by a CHECK constraint. */
export const MAX_RAW_PAYLOAD_BYTES = 1_048_576;

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const matchType = pgEnum('match_type', ['EXACT6', 'PREFIX3', 'SUFFIX3', 'SUFFIX2']);
export const verificationStatus = pgEnum('verification_status', [
  'PENDING',
  'VALIDATED',
  'VERIFIED',
  'QUARANTINED',
  'REJECTED',
]);
export const checkKind = pgEnum('check_kind', [
  'VALIDATION',
  'OFFICIAL_EVIDENCE',
  'OPERATOR_REVIEW',
]);
export const checkOutcome = pgEnum('check_outcome', ['PASS', 'WARN', 'FAIL']);

// ===== Reference data ========================================================

export const source = pgTable('source', {
  id: smallint('id').primaryKey().generatedAlwaysAsIdentity(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  baseUrl: text('base_url').notNull(),
  licence: text('licence').notNull(),
  termsUrl: text('terms_url'),
  isAuthoritative: boolean('is_authoritative').notNull().default(false),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const prizeCategory = pgTable(
  'prize_category',
  {
    id: smallint('id').primaryKey().generatedAlwaysAsIdentity(),
    code: text('code').notNull().unique(),
    nameTh: text('name_th').notNull(),
    nameEn: text('name_en').notNull(),
    matchType: matchType('match_type').notNull(),
    digits: smallint('digits').notNull(),
    sortOrder: smallint('sort_order').notNull().unique(),
  },
  (t) => [
    check(
      'prize_category_match_digits',
      sql`(${t.matchType} = 'EXACT6' AND ${t.digits} = 6)
       OR (${t.matchType} IN ('PREFIX3','SUFFIX3') AND ${t.digits} = 3)
       OR (${t.matchType} = 'SUFFIX2' AND ${t.digits} = 2)`,
    ),
  ],
);

/** D1: no validity dates — a draw's structure is inferred from its data. */
export const prizeStructure = pgTable('prize_structure', {
  id: smallint('id').primaryKey().generatedAlwaysAsIdentity(),
  code: text('code').notNull().unique(),
  description: text('description').notNull(),
  /** Informational only (observed in archived data), never used for inference. */
  firstObservedDraw: date('first_observed_draw', { mode: 'string' }),
  lastObservedDraw: date('last_observed_draw', { mode: 'string' }),
});

/** D2: expected counts only — no amounts. */
export const prizeStructureRule = pgTable(
  'prize_structure_rule',
  {
    prizeStructureId: smallint('prize_structure_id')
      .notNull()
      .references(() => prizeStructure.id),
    prizeCategoryId: smallint('prize_category_id')
      .notNull()
      .references(() => prizeCategory.id),
    expectedCount: smallint('expected_count').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.prizeStructureId, t.prizeCategoryId] }),
    check('prize_structure_rule_count', sql`${t.expectedCount} >= 0`),
  ],
);

// ===== Provenance ============================================================

export const importRun = pgTable(
  'import_run',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    sourceId: smallint('source_id')
      .notNull()
      .references(() => source.id),
    trigger: text('trigger').notNull(),
    status: text('status').notNull().default('RUNNING'),
    startedAt: ts('started_at').notNull().defaultNow(),
    finishedAt: ts('finished_at'),
    stats: jsonb('stats').notNull().default({}),
    error: text('error'),
  },
  (t) => [
    check(
      'import_run_trigger',
      sql`${t.trigger} IN ('schedule','drawday','reconcile','backfill','manual','fixture')`,
    ),
    check('import_run_status', sql`${t.status} IN ('RUNNING','SUCCEEDED','SKIPPED','FAILED')`),
    check('import_run_finished', sql`(${t.status} = 'RUNNING') = (${t.finishedAt} IS NULL)`),
    index('import_run_started_idx').on(t.startedAt.desc()),
  ],
);

/** D7 + raw-payload integrity: exact bytes, verified SHA-256, size cap, no secrets. */
export const rawPayload = pgTable(
  'raw_payload',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    sourceId: smallint('source_id')
      .notNull()
      .references(() => source.id),
    importRunId: bigint('import_run_id', { mode: 'number' }).references(() => importRun.id),
    endpoint: text('endpoint').notNull(),
    requestMethod: text('request_method').notNull(),
    requestParams: jsonb('request_params').notNull().default({}),
    httpStatus: integer('http_status').notNull(),
    fetchedAt: ts('fetched_at').notNull(),
    contentType: text('content_type'),
    /** Allow-listed response headers only (see raw-payload.ts). */
    responseHeaders: jsonb('response_headers').notNull().default({}),
    bodyBytes: bytea('body_bytes').notNull(),
    byteSize: integer('byte_size').notNull(),
    sha256: bytea('sha256').notNull(),
    /** Parsed copy for querying; NULL if the body is not valid JSON. */
    bodyJson: jsonb('body_json'),
    /** Free-text provenance, e.g. "live fetch" or "fixture:fixtures/glo/v1/...". */
    provenance: text('provenance').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique('raw_payload_dedupe').on(t.sourceId, t.endpoint, t.requestParams, t.sha256),
    check('raw_payload_method', sql`${t.requestMethod} IN ('GET','POST')`),
    check('raw_payload_http_status', sql`${t.httpStatus} BETWEEN 100 AND 599`),
    check(
      'raw_payload_size',
      sql`${t.byteSize} = octet_length(${t.bodyBytes}) AND ${t.byteSize} <= ${sql.raw(String(MAX_RAW_PAYLOAD_BYTES))}`,
    ),
    check('raw_payload_sha256', sql`${t.sha256} = sha256(${t.bodyBytes})`),
    check(
      'raw_payload_no_secret_headers',
      sql`NOT (${t.responseHeaders} ?| ARRAY['set-cookie','cookie','authorization','proxy-authorization','x-api-key'])`,
    ),
    check('raw_payload_provenance', sql`length(trim(${t.provenance})) > 0`),
  ],
);

// ===== Draws & versioned results =============================================

export const draw = pgTable(
  'draw',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    drawDate: date('draw_date', { mode: 'string' }).notNull().unique(),
    status: text('status').notNull().default('SCHEDULED'),
    /** FK (deferrable, same-draw) is added in migrations/0001. */
    currentResultSetId: bigint('current_result_set_id', { mode: 'number' }),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check('draw_status', sql`${t.status} IN ('SCHEDULED','PUBLISHED','POSTPONED','CANCELLED')`),
    check(
      'draw_published_has_current',
      sql`(${t.currentResultSetId} IS NULL) OR (${t.status} = 'PUBLISHED')`,
    ),
  ],
);

export const resultSet = pgTable(
  'result_set',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    drawId: integer('draw_id')
      .notNull()
      .references(() => draw.id),
    version: integer('version').notNull(),
    /** D4: structure belongs to the result data, not the draw. */
    prizeStructureId: smallint('prize_structure_id')
      .notNull()
      .references(() => prizeStructure.id),
    rawPayloadId: bigint('raw_payload_id', { mode: 'number' })
      .notNull()
      .references(() => rawPayload.id),
    importRunId: bigint('import_run_id', { mode: 'number' }).references(() => importRun.id),
    /** SHA-256 of the canonical encoding of the parsed result (see canonical.ts). */
    contentHash: bytea('content_hash').notNull(),
    verificationStatus: verificationStatus('verification_status').notNull().default('PENDING'),
    statusReason: text('status_reason'),
    createdAt: ts('created_at').notNull().defaultNow(),
    verifiedAt: ts('verified_at'),
    verifiedBy: text('verified_by'),
  },
  (t) => [
    unique('result_set_draw_version').on(t.drawId, t.version),
    // Target for same-draw composite FKs (draw pointer, corrections).
    unique('result_set_draw_id_id').on(t.drawId, t.id),
    check('result_set_version', sql`${t.version} >= 1`),
    check('result_set_content_hash', sql`octet_length(${t.contentHash}) = 32`),
    check(
      'result_set_verified_fields',
      sql`(${t.verificationStatus} = 'VERIFIED') = (${t.verifiedAt} IS NOT NULL AND ${t.verifiedBy} IS NOT NULL)`,
    ),
    check(
      'result_set_reason_required',
      sql`${t.verificationStatus} NOT IN ('QUARANTINED','REJECTED') OR length(trim(coalesce(${t.statusReason}, ''))) > 0`,
    ),
  ],
);

/** D3: amount is nullable (unknown / unverified). */
export const resultPrize = pgTable(
  'result_prize',
  {
    resultSetId: bigint('result_set_id', { mode: 'number' })
      .notNull()
      .references(() => resultSet.id),
    prizeCategoryId: smallint('prize_category_id')
      .notNull()
      .references(() => prizeCategory.id),
    amountBaht: numeric('amount_baht', { precision: 14, scale: 2 }),
  },
  (t) => [
    primaryKey({ columns: [t.resultSetId, t.prizeCategoryId] }),
    check('result_prize_amount', sql`${t.amountBaht} IS NULL OR ${t.amountBaht} >= 0`),
  ],
);

export const prizeNumber = pgTable(
  'prize_number',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    resultSetId: bigint('result_set_id', { mode: 'number' }).notNull(),
    prizeCategoryId: smallint('prize_category_id').notNull(),
    number: varchar('number', { length: 6 }).notNull(),
    /** GLO "round" (draw order), if known. */
    drawOrder: smallint('draw_order'),
  },
  (t) => [
    // Every number belongs to a declared prize row of the same result set.
    foreignKey({
      name: 'prize_number_prize_fk',
      columns: [t.resultSetId, t.prizeCategoryId],
      foreignColumns: [resultPrize.resultSetId, resultPrize.prizeCategoryId],
    }),
    unique('prize_number_unique').on(t.resultSetId, t.prizeCategoryId, t.number),
    check('prize_number_digits', sql`${t.number} ~ '^[0-9]{2,6}$'`),
    // (result_set_id, …) lookups use the prize_number_unique index.
  ],
);

export const verificationCheck = pgTable(
  'verification_check',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    resultSetId: bigint('result_set_id', { mode: 'number' })
      .notNull()
      .references(() => resultSet.id),
    checkKind: checkKind('check_kind').notNull(),
    checkCode: text('check_code').notNull(),
    outcome: checkOutcome('outcome').notNull(),
    details: jsonb('details').notNull().default({}),
    /** Required for OFFICIAL_EVIDENCE: what official artefact was compared (URL, hash, fixture path). */
    evidenceRef: text('evidence_ref'),
    performedBy: text('performed_by').notNull(),
    checkedAt: ts('checked_at').notNull().defaultNow(),
  },
  (t) => [
    check(
      'verification_check_evidence_ref',
      sql`${t.checkKind} <> 'OFFICIAL_EVIDENCE' OR length(trim(coalesce(${t.evidenceRef}, ''))) > 0`,
    ),
    check('verification_check_performed_by', sql`length(trim(${t.performedBy})) > 0`),
    index('verification_check_result_set_idx').on(t.resultSetId),
  ],
);

export const correction = pgTable(
  'correction',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    drawId: integer('draw_id')
      .notNull()
      .references(() => draw.id),
    fromResultSetId: bigint('from_result_set_id', { mode: 'number' }).notNull(),
    toResultSetId: bigint('to_result_set_id', { mode: 'number' }).notNull(),
    reason: text('reason').notNull(),
    detectedBy: text('detected_by').notNull(),
    approvedBy: text('approved_by').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'correction_from_same_draw_fk',
      columns: [t.drawId, t.fromResultSetId],
      foreignColumns: [resultSet.drawId, resultSet.id],
    }),
    foreignKey({
      name: 'correction_to_same_draw_fk',
      columns: [t.drawId, t.toResultSetId],
      foreignColumns: [resultSet.drawId, resultSet.id],
    }),
    check('correction_distinct', sql`${t.fromResultSetId} <> ${t.toResultSetId}`),
    check(
      'correction_detected_by',
      sql`${t.detectedBy} IN ('reconcile','validator','operator','public_report')`,
    ),
    check('correction_reason', sql`length(trim(${t.reason})) > 0`),
    check('correction_approved_by', sql`length(trim(${t.approvedBy})) > 0`),
  ],
);

/** Written only by SECURITY DEFINER triggers (migrations/0001); runtime roles cannot insert. */
export const auditLog = pgTable(
  'audit_log',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    actor: text('actor').notNull(),
    dbRole: text('db_role').notNull(),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    before: jsonb('before'),
    after: jsonb('after'),
    at: ts('at').notNull().defaultNow(),
  },
  (t) => [index('audit_log_entity_idx').on(t.entityType, t.entityId, t.at.desc())],
);
