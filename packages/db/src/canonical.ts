import { createHash } from 'node:crypto';
import { PRIZE_CATEGORIES } from '@lekvero/shared';
import type { DrawResult } from '@lekvero/shared';

/**
 * Deterministic encoding of a draw's CONTENT (date, structure, categories,
 * amounts, numbers). Numbers are sorted, so a change only in draw order is not
 * a content change. Bump `v` if the encoding ever changes.
 */
export function canonicalEncoding(draw: DrawResult): string {
  const prizes = [...draw.prizes]
    .sort((a, b) => PRIZE_CATEGORIES[a.category].sortOrder - PRIZE_CATEGORIES[b.category].sortOrder)
    .map((p) => ({ c: p.category, a: p.amountBaht, n: [...p.numbers].sort() }));
  return JSON.stringify({ v: 1, d: draw.drawDate, s: draw.prizeStructure, p: prizes });
}

export function contentHash(draw: DrawResult): Buffer {
  return createHash('sha256').update(canonicalEncoding(draw), 'utf8').digest();
}
