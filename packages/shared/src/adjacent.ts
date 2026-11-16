import { parseTicketNumber } from './ticket';

export interface AdjacentNumbers {
  /** first − 1, wrapping 000000 → 999999 */
  readonly lower: string;
  /** first + 1, wrapping 999999 → 000000 */
  readonly upper: string;
  /** True when lower or upper needed wrap-around. */
  readonly wraps: boolean;
}

/**
 * Compute the numbers adjacent to a first-prize number.
 *
 * Used ONLY by validation to sanity-check published `near1` numbers. The
 * matcher never derives near1 itself; it uses the numbers GLO published.
 *
 * ASSUMPTION (unverified): at the 000000 / 999999 boundary GLO wraps around.
 * No archived draw exercises this, so validation reports a boundary draw as a
 * warning instead of trusting this function.
 */
export function adjacentNumbers(first: string): AdjacentNumbers {
  const n = Number(parseTicketNumber(first));
  const pad = (v: number) => v.toString().padStart(6, '0');
  return {
    lower: pad((n + 999_999) % 1_000_000),
    upper: pad((n + 1) % 1_000_000),
    wraps: n === 0 || n === 999_999,
  };
}
