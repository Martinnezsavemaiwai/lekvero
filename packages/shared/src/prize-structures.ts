import { z } from 'zod';
import type { PrizeCategoryCode } from './prize-categories';

/**
 * A prize structure ("era") fixes WHICH categories a draw has and HOW MANY
 * numbers each category contains. It deliberately carries no amounts and no
 * validity dates: the exact changeover draw is not yet verified (see
 * docs/research/data-sources.md §3.3), so a draw's structure is taken from
 * the draw's own data, never guessed from its date.
 *
 * Expected counts below were OBSERVED in archived GLO responses:
 * - LEGACY_LAST3X4:      2011-02-01, 2013-02-01, 2015-01-16
 * - MODERN_FRONT3_BACK3: 2020-01-17, 2024-03-01, 2024-12-16, 2025-01-17, 2026-11-16
 */
export const PRIZE_STRUCTURE_CODES = ['LEGACY_LAST3X4', 'MODERN_FRONT3_BACK3'] as const;
export const PrizeStructureCodeSchema = z.enum(PRIZE_STRUCTURE_CODES);
export type PrizeStructureCode = z.infer<typeof PrizeStructureCodeSchema>;

export interface PrizeStructureDefinition {
  readonly code: PrizeStructureCode;
  readonly description: string;
  /** Categories present in this structure, with expected number counts. */
  readonly expectedCounts: Readonly<Partial<Record<PrizeCategoryCode, number>>>;
}

const SIX_DIGIT_COUNTS = {
  first: 1,
  near1: 2,
  second: 5,
  third: 10,
  fourth: 50,
  fifth: 100,
} as const;

export const PRIZE_STRUCTURES: Readonly<Record<PrizeStructureCode, PrizeStructureDefinition>> =
  Object.freeze({
    LEGACY_LAST3X4: Object.freeze({
      code: 'LEGACY_LAST3X4',
      description:
        'Older structure: four "last three digits" prizes, no "first three digits" prize.',
      expectedCounts: Object.freeze({ ...SIX_DIGIT_COUNTS, last3b: 4, last2: 1 }),
    }),
    MODERN_FRONT3_BACK3: Object.freeze({
      code: 'MODERN_FRONT3_BACK3',
      description:
        'Current structure: two "first three digits" and two "last three digits" prizes.',
      expectedCounts: Object.freeze({ ...SIX_DIGIT_COUNTS, last3f: 2, last3b: 2, last2: 1 }),
    }),
  });

export function categoriesOf(structure: PrizeStructureCode): PrizeCategoryCode[] {
  return Object.keys(PRIZE_STRUCTURES[structure].expectedCounts) as PrizeCategoryCode[];
}

/**
 * Identify the structure from the number of 3-digit prizes a draw actually
 * published. Returns null if the shape matches no known structure.
 */
export function inferPrizeStructure(counts: {
  last3f: number;
  last3b: number;
}): PrizeStructureCode | null {
  if (counts.last3f === 0 && counts.last3b === 4) return 'LEGACY_LAST3X4';
  if (counts.last3f === 2 && counts.last3b === 2) return 'MODERN_FRONT3_BACK3';
  return null;
}
