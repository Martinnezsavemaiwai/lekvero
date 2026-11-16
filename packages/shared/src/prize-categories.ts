import { z } from 'zod';

/**
 * How a published prize number is compared with a six-digit ticket.
 * - EXACT6:  all six digits equal
 * - PREFIX3: ticket's first three digits equal the 3-digit prize number
 * - SUFFIX3: ticket's last three digits equal the 3-digit prize number
 * - SUFFIX2: ticket's last two digits equal the 2-digit prize number
 */
export const MATCH_TYPES = ['EXACT6', 'PREFIX3', 'SUFFIX3', 'SUFFIX2'] as const;
export type MatchType = (typeof MATCH_TYPES)[number];

/** Category codes deliberately equal the GLO API `data` keys. */
export const PRIZE_CATEGORY_CODES = [
  'first',
  'near1',
  'second',
  'third',
  'fourth',
  'fifth',
  'last3f',
  'last3b',
  'last2',
] as const;
export const PrizeCategoryCodeSchema = z.enum(PRIZE_CATEGORY_CODES);
export type PrizeCategoryCode = z.infer<typeof PrizeCategoryCodeSchema>;

export interface PrizeCategoryDefinition {
  readonly code: PrizeCategoryCode;
  readonly matchType: MatchType;
  /** Number of digits in the published prize number. */
  readonly digits: 2 | 3 | 6;
  readonly sortOrder: number;
  readonly nameTh: string;
  readonly nameEn: string;
}

const def = (
  code: PrizeCategoryCode,
  matchType: MatchType,
  digits: 2 | 3 | 6,
  sortOrder: number,
  nameTh: string,
  nameEn: string,
): PrizeCategoryDefinition => Object.freeze({ code, matchType, digits, sortOrder, nameTh, nameEn });

/**
 * Static category semantics. No prize AMOUNTS live here on purpose: amounts are
 * per-draw data and must never be assumed from current values.
 */
export const PRIZE_CATEGORIES: Readonly<Record<PrizeCategoryCode, PrizeCategoryDefinition>> =
  Object.freeze({
    first: def('first', 'EXACT6', 6, 1, 'รางวัลที่ 1', 'First prize'),
    near1: def('near1', 'EXACT6', 6, 2, 'รางวัลข้างเคียงรางวัลที่ 1', 'Adjacent to first prize'),
    second: def('second', 'EXACT6', 6, 3, 'รางวัลที่ 2', 'Second prize'),
    third: def('third', 'EXACT6', 6, 4, 'รางวัลที่ 3', 'Third prize'),
    fourth: def('fourth', 'EXACT6', 6, 5, 'รางวัลที่ 4', 'Fourth prize'),
    fifth: def('fifth', 'EXACT6', 6, 6, 'รางวัลที่ 5', 'Fifth prize'),
    last3f: def('last3f', 'PREFIX3', 3, 7, 'รางวัลเลขหน้า 3 ตัว', 'First three digits'),
    last3b: def('last3b', 'SUFFIX3', 3, 8, 'รางวัลเลขท้าย 3 ตัว', 'Last three digits'),
    last2: def('last2', 'SUFFIX2', 2, 9, 'รางวัลเลขท้าย 2 ตัว', 'Last two digits'),
  });

/** True when `ticket` (six digits) matches `prizeNumber` under `matchType`. */
export function matches(matchType: MatchType, ticket: string, prizeNumber: string): boolean {
  switch (matchType) {
    case 'EXACT6':
      return ticket === prizeNumber;
    case 'PREFIX3':
      return ticket.slice(0, 3) === prizeNumber;
    case 'SUFFIX3':
      return ticket.slice(3) === prizeNumber;
    case 'SUFFIX2':
      return ticket.slice(4) === prizeNumber;
  }
}
