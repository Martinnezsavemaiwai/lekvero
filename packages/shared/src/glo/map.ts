import type { DrawResult, Prize } from '../draw';
import { PRIZE_CATEGORY_CODES } from '../prize-categories';
import { inferPrizeStructure } from '../prize-structures';
import type { PrizeStructureCode } from '../prize-structures';
import type { GloDraw } from './schema';

export class UnknownPrizeStructureError extends Error {
  override readonly name = 'UnknownPrizeStructureError';
}

export interface MapOptions {
  /**
   * How to treat GLO-reported `price` values for LEGACY-structure draws.
   * GLO returns current-looking amounts even for 2011 draws, which are
   * unverified (docs/research/data-sources.md §3.3). Default 'omit' → null.
   */
  readonly legacyAmounts?: 'omit' | 'reported';
}

/**
 * Map a schema-valid GLO draw object to the canonical DrawResult.
 * Pure; performs no validation beyond structure detection. Run
 * `validateDrawResult` on the output.
 */
export function mapGloDraw(raw: GloDraw, options: MapOptions = {}): DrawResult {
  const { data } = raw;
  const structure: PrizeStructureCode | null = inferPrizeStructure({
    last3f: data.last3f.number.length,
    last3b: data.last3b.number.length,
  });
  if (!structure) {
    throw new UnknownPrizeStructureError(
      `Draw ${raw.date}: unknown prize structure (last3f=${data.last3f.number.length}, last3b=${data.last3b.number.length}).`,
    );
  }
  const keepAmounts = structure !== 'LEGACY_LAST3X4' || options.legacyAmounts === 'reported';

  const prizes: Prize[] = [];
  for (const code of PRIZE_CATEGORY_CODES) {
    const block = data[code];
    if (block.number.length === 0) continue; // e.g. last3f in legacy draws
    prizes.push({
      category: code,
      numbers: [...block.number].sort((a, b) => a.round - b.round).map((n) => n.value),
      amountBaht: keepAmounts ? block.price : null,
    });
  }
  return { drawDate: raw.date, prizeStructure: structure, prizes };
}
