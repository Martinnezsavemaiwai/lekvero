/**
 * Verification lifecycle operations. The database triggers are the source of
 * truth for which transitions are legal and what evidence they need; these
 * functions are the sanctioned way to perform them.
 *
 *   PENDING ──validation pass──▶ VALIDATED ──official evidence──▶ VERIFIED
 *      │                             │
 *      └──validation fail / conflict─┴──▶ QUARANTINED ──evidence + operator review──▶ VERIFIED
 *   PENDING | VALIDATED | QUARANTINED ──operator──▶ REJECTED
 */
import { eq } from 'drizzle-orm';
import type pg from 'pg';
import { NotFoundError } from './errors';
import { correction, draw, resultSet, verificationCheck } from './schema';
import { withTransaction } from './tx';

export interface OfficialEvidence {
  /** e.g. 'glo_checker_crosscheck', 'glo_pdf_comparison', 'archived_glo_checker_fixture'. */
  readonly code: string;
  readonly outcome: 'PASS' | 'WARN' | 'FAIL';
  /** What official artefact was compared: URL, PDF hash, fixture path… (required). */
  readonly evidenceRef: string;
  readonly performedBy: string;
  readonly details?: Record<string, unknown>;
}

export async function recordOfficialEvidence(
  pool: pg.Pool,
  actor: string,
  resultSetId: number,
  evidence: OfficialEvidence,
): Promise<void> {
  await withTransaction(pool, { actor }, ({ db }) =>
    db.insert(verificationCheck).values({
      resultSetId,
      checkKind: 'OFFICIAL_EVIDENCE',
      checkCode: evidence.code,
      outcome: evidence.outcome,
      evidenceRef: evidence.evidenceRef,
      performedBy: evidence.performedBy,
      details: evidence.details ?? {},
    }),
  );
}

export async function recordOperatorReview(
  pool: pg.Pool,
  actor: string,
  resultSetId: number,
  review: { outcome: 'PASS' | 'FAIL'; performedBy: string; notes: string },
): Promise<void> {
  await withTransaction(pool, { actor }, ({ db }) =>
    db.insert(verificationCheck).values({
      resultSetId,
      checkKind: 'OPERATOR_REVIEW',
      checkCode: 'operator_review',
      outcome: review.outcome,
      performedBy: review.performedBy,
      details: { notes: review.notes },
    }),
  );
}

export interface VerifyOutcome {
  readonly resultSetId: number;
  /** True if the draw had no current result and now points at this one. */
  readonly becameCurrent: boolean;
}

/**
 * Promote a result set to VERIFIED (trigger enforces the evidence rules).
 * If its draw has no current result yet, it becomes current and the draw
 * PUBLISHED. Replacing an existing current result needs approveCorrection().
 */
export async function verifyResultSet(
  pool: pg.Pool,
  actor: string,
  resultSetId: number,
  verifiedBy: string,
): Promise<VerifyOutcome> {
  return withTransaction(pool, { actor }, async ({ db }) => {
    const [rs] = await db
      .select({ drawId: resultSet.drawId })
      .from(resultSet)
      .where(eq(resultSet.id, resultSetId));
    if (!rs) throw new NotFoundError(`result_set ${resultSetId} not found`);
    const [d] = await db
      .select({ currentId: draw.currentResultSetId })
      .from(draw)
      .where(eq(draw.id, rs.drawId))
      .for('update');

    await db
      .update(resultSet)
      .set({ verificationStatus: 'VERIFIED', verifiedAt: new Date(), verifiedBy })
      .where(eq(resultSet.id, resultSetId));

    if (d?.currentId === null || d?.currentId === undefined) {
      await db
        .update(draw)
        .set({ currentResultSetId: resultSetId, status: 'PUBLISHED' })
        .where(eq(draw.id, rs.drawId));
      return { resultSetId, becameCurrent: true };
    }
    return { resultSetId, becameCurrent: false };
  });
}

export async function quarantineResultSet(
  pool: pg.Pool,
  actor: string,
  resultSetId: number,
  reason: string,
): Promise<void> {
  await withTransaction(pool, { actor }, ({ db }) =>
    db
      .update(resultSet)
      .set({ verificationStatus: 'QUARANTINED', statusReason: reason })
      .where(eq(resultSet.id, resultSetId)),
  );
}

export async function rejectResultSet(
  pool: pg.Pool,
  actor: string,
  resultSetId: number,
  reason: string,
): Promise<void> {
  await withTransaction(pool, { actor }, ({ db }) =>
    db
      .update(resultSet)
      .set({ verificationStatus: 'REJECTED', statusReason: reason })
      .where(eq(resultSet.id, resultSetId)),
  );
}

/**
 * Make an already-VERIFIED result set the current one for its draw, replacing
 * the existing current result. Records a correction in the same transaction;
 * the draw trigger refuses the pointer change without it.
 */
export async function approveCorrection(
  pool: pg.Pool,
  actor: string,
  input: {
    toResultSetId: number;
    reason: string;
    detectedBy: 'reconcile' | 'validator' | 'operator' | 'public_report';
    approvedBy: string;
  },
): Promise<{ correctionId: number; fromResultSetId: number }> {
  return withTransaction(pool, { actor }, async ({ db }) => {
    const [rs] = await db
      .select({ drawId: resultSet.drawId })
      .from(resultSet)
      .where(eq(resultSet.id, input.toResultSetId));
    if (!rs) throw new NotFoundError(`result_set ${input.toResultSetId} not found`);
    const [d] = await db
      .select({ currentId: draw.currentResultSetId })
      .from(draw)
      .where(eq(draw.id, rs.drawId))
      .for('update');
    if (d?.currentId === null || d?.currentId === undefined) {
      throw new Error('Draw has no current result; use verifyResultSet() instead of a correction.');
    }
    const [c] = await db
      .insert(correction)
      .values({
        drawId: rs.drawId,
        fromResultSetId: d.currentId,
        toResultSetId: input.toResultSetId,
        reason: input.reason,
        detectedBy: input.detectedBy,
        approvedBy: input.approvedBy,
      })
      .returning({ id: correction.id });
    await db
      .update(draw)
      .set({ currentResultSetId: input.toResultSetId })
      .where(eq(draw.id, rs.drawId));
    return { correctionId: c!.id, fromResultSetId: d.currentId };
  });
}
