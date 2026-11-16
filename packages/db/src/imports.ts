import { and, desc, eq } from 'drizzle-orm';
import type pg from 'pg';
import { PRIZE_CATEGORIES } from '@lekvero/shared';
import type { DrawResult, ValidationReport } from '@lekvero/shared';
import { contentHash } from './canonical';
import { UnstorableResultError } from './errors';
import {
  correction,
  draw,
  importRun,
  prizeCategory,
  prizeNumber,
  prizeStructure,
  resultPrize,
  resultSet,
  source,
  verificationCheck,
} from './schema';
import { withTransaction } from './tx';
import type { TxContext } from './tx';

/** Validation issues that make a result impossible to store faithfully. */
const UNSTORABLE = new Set([
  'wrong_digit_length',
  'duplicate_number',
  'duplicate_category',
  'unexpected_category',
]);

export type ImportRunTrigger =
  'schedule' | 'drawday' | 'reconcile' | 'backfill' | 'manual' | 'fixture';

export async function startImportRun(
  pool: pg.Pool,
  actor: string,
  sourceCode: string,
  trigger: ImportRunTrigger,
): Promise<number> {
  return withTransaction(pool, { actor }, async ({ db }) => {
    const [src] = await db
      .select({ id: source.id })
      .from(source)
      .where(eq(source.code, sourceCode));
    if (!src) throw new Error(`Unknown source ${sourceCode}`);
    const [run] = await db
      .insert(importRun)
      .values({ sourceId: src.id, trigger })
      .returning({ id: importRun.id });
    return run!.id;
  });
}

export async function finishImportRun(
  pool: pg.Pool,
  actor: string,
  id: number,
  status: 'SUCCEEDED' | 'SKIPPED' | 'FAILED',
  stats: Record<string, unknown> = {},
  error: string | null = null,
): Promise<void> {
  await withTransaction(pool, { actor }, ({ db }) =>
    db
      .update(importRun)
      .set({ status, stats, error, finishedAt: new Date() })
      .where(eq(importRun.id, id)),
  );
}

export interface RecordImportInput {
  readonly rawPayloadId: number;
  readonly importRunId?: number | null;
  readonly result: DrawResult;
  /** Output of validateDrawResult(result) from @lekvero/shared. */
  readonly validation: ValidationReport;
}

export type RecordImportOutcome =
  | { readonly outcome: 'unchanged'; readonly resultSetId: number; readonly version: number }
  | {
      readonly outcome: 'created';
      readonly resultSetId: number;
      readonly version: number;
      readonly status: 'VALIDATED' | 'QUARANTINED';
      readonly reason: string | null;
    };

/**
 * Record one parsed draw result as a new immutable version, in ONE transaction.
 *
 * - The draw row is locked (`SELECT … FOR UPDATE`), so concurrent imports of
 *   the same draw are serialised and versions are allocated deterministically
 *   as max(version)+1 with no gaps (a rolled-back attempt allocates nothing).
 * - Content identical to the current or latest version → `unchanged`.
 * - First version: VALIDATED if validation passed, else QUARANTINED.
 * - A differing version while any non-rejected version exists → QUARANTINED
 *   (correction candidate; needs operator review). Nothing ever becomes
 *   VERIFIED here: that requires official evidence (lifecycle.ts).
 */
export async function recordImport(
  pool: pg.Pool,
  actor: string,
  input: RecordImportInput,
): Promise<RecordImportOutcome> {
  const unstorable = input.validation.issues.filter((i) => UNSTORABLE.has(i.code));
  if (unstorable.length > 0) {
    throw new UnstorableResultError(
      `Result for ${input.result.drawDate} cannot be stored faithfully: ${unstorable.map((i) => i.message).join(' ')}`,
    );
  }
  const hash = contentHash(input.result);
  return withTransaction(pool, { actor }, (tx) => recordImportTx(tx, input, hash));
}

async function recordImportTx(
  { db }: TxContext,
  input: RecordImportInput,
  hash: Buffer,
): Promise<RecordImportOutcome> {
  const { result, validation } = input;

  await db.insert(draw).values({ drawDate: result.drawDate }).onConflictDoNothing();
  const [d] = await db
    .select({ id: draw.id, currentId: draw.currentResultSetId })
    .from(draw)
    .where(eq(draw.drawDate, result.drawDate))
    .for('update');
  if (!d) throw new Error(`draw ${result.drawDate} vanished`);

  const versions = await db
    .select({
      id: resultSet.id,
      version: resultSet.version,
      hash: resultSet.contentHash,
      status: resultSet.verificationStatus,
    })
    .from(resultSet)
    .where(eq(resultSet.drawId, d.id))
    .orderBy(desc(resultSet.version));
  const latest = versions[0];

  // "Unchanged" = same content as the current version, or as any version that a
  // correction has NOT superseded (newest first). Superseded versions are excluded
  // so A → B → A creates a new version that can be approved (D5); everything else
  // matches, so a re-delivered X after Y (X,Y,X) does not create a duplicate.
  const superseded = new Set(
    (
      await db
        .select({ id: correction.fromResultSetId })
        .from(correction)
        .where(eq(correction.drawId, d.id))
    ).map((c) => c.id),
  );
  const match = versions.find(
    (v) => v.hash.equals(hash) && (v.id === d.currentId || !superseded.has(v.id)),
  );
  if (match) return { outcome: 'unchanged', resultSetId: match.id, version: match.version };

  const version = (latest?.version ?? 0) + 1;
  const [structure] = await db
    .select({ id: prizeStructure.id })
    .from(prizeStructure)
    .where(eq(prizeStructure.code, result.prizeStructure));
  if (!structure) throw new Error(`Unknown prize structure ${result.prizeStructure}`);

  const [rs] = await db
    .insert(resultSet)
    .values({
      drawId: d.id,
      version,
      prizeStructureId: structure.id,
      rawPayloadId: input.rawPayloadId,
      importRunId: input.importRunId ?? null,
      contentHash: hash,
    })
    .returning({ id: resultSet.id });
  const rsId = rs!.id;

  const categories = await db
    .select({ id: prizeCategory.id, code: prizeCategory.code })
    .from(prizeCategory);
  const catId = new Map(categories.map((c) => [c.code, c.id]));
  const prizes = result.prizes.filter((p) => p.numbers.length > 0);
  if (prizes.length > 0) {
    await db.insert(resultPrize).values(
      prizes.map((p) => ({
        resultSetId: rsId,
        prizeCategoryId: catId.get(p.category)!,
        amountBaht: p.amountBaht,
      })),
    );
    await db.insert(prizeNumber).values(
      prizes.flatMap((p) =>
        p.numbers.map((n, i) => ({
          resultSetId: rsId,
          prizeCategoryId: catId.get(p.category)!,
          number: n,
          drawOrder: i + 1,
        })),
      ),
    );
  }

  const performedBy = 'system:validator';
  await db.insert(verificationCheck).values([
    {
      resultSetId: rsId,
      checkKind: 'VALIDATION' as const,
      checkCode: 'validate_draw_result',
      outcome: validation.ok ? ('PASS' as const) : ('FAIL' as const),
      details: { issueCount: validation.issues.length },
      performedBy,
    },
    ...validation.issues.map((i) => ({
      resultSetId: rsId,
      checkKind: 'VALIDATION' as const,
      checkCode: i.code,
      outcome: i.severity === 'error' ? ('FAIL' as const) : ('WARN' as const),
      details: { category: i.category ?? null, message: i.message },
      performedBy,
    })),
  ]);

  const others = versions.filter((v) => v.status !== 'REJECTED');
  let status: 'VALIDATED' | 'QUARANTINED';
  let reason: string | null = null;
  if (!validation.ok) {
    status = 'QUARANTINED';
    reason = `validation_failed: ${[...new Set(validation.issues.filter((i) => i.severity === 'error').map((i) => i.code))].join(',')}`;
  } else if (others.length > 0) {
    status = 'QUARANTINED';
    reason = `conflicts_with_existing_versions: ${others.map((v) => `v${v.version}(${v.status})`).join(',')}`;
  } else {
    status = 'VALIDATED';
  }
  await db
    .update(resultSet)
    .set({ verificationStatus: status, statusReason: reason })
    .where(and(eq(resultSet.id, rsId), eq(resultSet.verificationStatus, 'PENDING')));

  return { outcome: 'created', resultSetId: rsId, version, status, reason };
}

/** Sort helper shared with reads. */
export function categorySort(a: string, b: string): number {
  return (
    PRIZE_CATEGORIES[a as keyof typeof PRIZE_CATEGORIES].sortOrder -
    PRIZE_CATEGORIES[b as keyof typeof PRIZE_CATEGORIES].sortOrder
  );
}
