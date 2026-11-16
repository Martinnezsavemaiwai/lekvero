import { asc, eq } from 'drizzle-orm';
import type { DrawResult, PrizeCategoryCode, PrizeStructureCode } from '@lekvero/shared';
import type { Db } from './client';
import { categorySort } from './imports';
import { draw, prizeCategory, prizeNumber, prizeStructure, resultPrize, resultSet } from './schema';

export interface StoredResultSet {
  readonly resultSetId: number;
  readonly drawDate: string;
  readonly version: number;
  readonly verificationStatus: 'PENDING' | 'VALIDATED' | 'VERIFIED' | 'QUARANTINED' | 'REJECTED';
  readonly statusReason: string | null;
  readonly isCurrent: boolean;
  readonly result: DrawResult;
}

/** Rebuild the canonical DrawResult for one result set (works with the reader role). */
export async function getResultSet(db: Db, resultSetId: number): Promise<StoredResultSet | null> {
  const [head] = await db
    .select({
      id: resultSet.id,
      version: resultSet.version,
      status: resultSet.verificationStatus,
      reason: resultSet.statusReason,
      drawDate: draw.drawDate,
      currentId: draw.currentResultSetId,
      structure: prizeStructure.code,
    })
    .from(resultSet)
    .innerJoin(draw, eq(draw.id, resultSet.drawId))
    .innerJoin(prizeStructure, eq(prizeStructure.id, resultSet.prizeStructureId))
    .where(eq(resultSet.id, resultSetId));
  if (!head) return null;

  const prizes = await db
    .select({ code: prizeCategory.code, amount: resultPrize.amountBaht })
    .from(resultPrize)
    .innerJoin(prizeCategory, eq(prizeCategory.id, resultPrize.prizeCategoryId))
    .where(eq(resultPrize.resultSetId, resultSetId));
  const numbers = await db
    .select({ code: prizeCategory.code, number: prizeNumber.number })
    .from(prizeNumber)
    .innerJoin(prizeCategory, eq(prizeCategory.id, prizeNumber.prizeCategoryId))
    .where(eq(prizeNumber.resultSetId, resultSetId))
    .orderBy(asc(prizeNumber.drawOrder), asc(prizeNumber.id));

  const result: DrawResult = {
    drawDate: head.drawDate,
    prizeStructure: head.structure as PrizeStructureCode,
    prizes: prizes
      .sort((a, b) => categorySort(a.code, b.code))
      .map((p) => ({
        category: p.code as PrizeCategoryCode,
        amountBaht: p.amount,
        numbers: numbers.filter((n) => n.code === p.code).map((n) => n.number),
      })),
  };
  return {
    resultSetId: head.id,
    drawDate: head.drawDate,
    version: head.version,
    verificationStatus: head.status,
    statusReason: head.reason,
    isCurrent: head.currentId === head.id,
    result,
  };
}

/** The current (VERIFIED) result for a draw date, or null if none is published. */
export async function getCurrentResult(db: Db, drawDate: string): Promise<StoredResultSet | null> {
  const [d] = await db
    .select({ currentId: draw.currentResultSetId })
    .from(draw)
    .where(eq(draw.drawDate, drawDate));
  return d?.currentId === null || d?.currentId === undefined ? null : getResultSet(db, d.currentId);
}

export async function listVersions(
  db: Db,
  drawDate: string,
): Promise<Array<{ resultSetId: number; version: number; status: string; reason: string | null }>> {
  return db
    .select({
      resultSetId: resultSet.id,
      version: resultSet.version,
      status: resultSet.verificationStatus,
      reason: resultSet.statusReason,
    })
    .from(resultSet)
    .innerJoin(draw, eq(draw.id, resultSet.drawId))
    .where(eq(draw.drawDate, drawDate))
    .orderBy(asc(resultSet.version));
}
