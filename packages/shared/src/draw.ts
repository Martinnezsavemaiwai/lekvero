import { z } from 'zod';
import { adjacentNumbers } from './adjacent';
import { BahtAmountSchema } from './money';
import { PRIZE_CATEGORIES, PrizeCategoryCodeSchema } from './prize-categories';
import type { PrizeCategoryCode } from './prize-categories';
import { PRIZE_STRUCTURES, PrizeStructureCodeSchema, categoriesOf } from './prize-structures';

export const PrizeSchema = z.object({
  category: PrizeCategoryCodeSchema,
  /** Published numbers as strings (2, 3 or 6 digits depending on category). */
  numbers: z.array(z.string().regex(/^[0-9]{2,6}$/)),
  /**
   * Amount per ticket for THIS draw, as reported by the source, or null when
   * unknown/unverified. Never filled in from current prize values.
   */
  amountBaht: BahtAmountSchema.nullable(),
});
export type Prize = z.infer<typeof PrizeSchema>;

/** Canonical, source-independent result of one draw. */
export const DrawResultSchema = z.object({
  drawDate: z.iso.date(),
  prizeStructure: PrizeStructureCodeSchema,
  prizes: z.array(PrizeSchema),
});
export type DrawResult = z.infer<typeof DrawResultSchema>;

export type IssueSeverity = 'error' | 'warning';
export interface ValidationIssue {
  readonly severity: IssueSeverity;
  readonly code:
    | 'missing_category'
    | 'unexpected_category'
    | 'duplicate_category'
    | 'wrong_count'
    | 'wrong_digit_length'
    | 'duplicate_number'
    | 'near1_not_adjacent'
    | 'near1_boundary_unverified';
  readonly category?: PrizeCategoryCode;
  readonly message: string;
}
export interface ValidationReport {
  /** True when there are no error-severity issues. */
  readonly ok: boolean;
  readonly issues: readonly ValidationIssue[];
}

/**
 * Structural and semantic checks of a draw against its declared prize
 * structure. Pure; no I/O. Checks:
 * category set, counts, digit lengths, duplicates, near1 adjacency.
 */
export function validateDrawResult(draw: DrawResult): ValidationReport {
  const issues: ValidationIssue[] = [];
  const structure = PRIZE_STRUCTURES[draw.prizeStructure];
  const expected = new Set(categoriesOf(draw.prizeStructure));
  const seen = new Map<PrizeCategoryCode, z.infer<typeof PrizeSchema>>();

  for (const prize of draw.prizes) {
    if (seen.has(prize.category)) {
      issues.push({
        severity: 'error',
        code: 'duplicate_category',
        category: prize.category,
        message: `Category ${prize.category} appears more than once.`,
      });
      continue;
    }
    seen.set(prize.category, prize);
    const def = PRIZE_CATEGORIES[prize.category];
    const expectedCount = structure.expectedCounts[prize.category] ?? 0;

    if (!expected.has(prize.category) && prize.numbers.length > 0) {
      issues.push({
        severity: 'error',
        code: 'unexpected_category',
        category: prize.category,
        message: `Category ${prize.category} is not part of ${structure.code}.`,
      });
      continue;
    }
    const boundaryNear1 = prize.category === 'near1' && isBoundaryFirst(draw);
    if (prize.numbers.length !== expectedCount && !boundaryNear1) {
      issues.push({
        severity: 'error',
        code: 'wrong_count',
        category: prize.category,
        message: `Expected ${expectedCount} number(s) for ${prize.category}, got ${prize.numbers.length}.`,
      });
    }
    for (const n of prize.numbers) {
      if (n.length !== def.digits) {
        issues.push({
          severity: 'error',
          code: 'wrong_digit_length',
          category: prize.category,
          message: `${prize.category} number "${n}" must have ${def.digits} digits.`,
        });
      }
    }
    if (new Set(prize.numbers).size !== prize.numbers.length) {
      issues.push({
        severity: 'error',
        code: 'duplicate_number',
        category: prize.category,
        message: `${prize.category} contains duplicate numbers.`,
      });
    }
  }

  for (const code of expected) {
    if (!seen.has(code)) {
      issues.push({
        severity: 'error',
        code: 'missing_category',
        category: code,
        message: `Category ${code} is missing.`,
      });
    }
  }

  checkNear1(seen.get('first'), seen.get('near1'), issues);
  return { ok: !issues.some((i) => i.severity === 'error'), issues };
}

function isBoundaryFirst(draw: DrawResult): boolean {
  const first = draw.prizes.find((p) => p.category === 'first')?.numbers[0];
  return first === '000000' || first === '999999';
}

function checkNear1(
  first: Prize | undefined,
  near1: Prize | undefined,
  issues: ValidationIssue[],
): void {
  const firstNumber = first?.numbers[0];
  if (!near1 || first?.numbers.length !== 1 || !firstNumber || !/^[0-9]{6}$/.test(firstNumber))
    return;
  const adj = adjacentNumbers(firstNumber);
  if (adj.wraps) {
    issues.push({
      severity: 'warning',
      code: 'near1_boundary_unverified',
      category: 'near1',
      message: `First prize ${firstNumber} is at the 000000/999999 boundary; GLO's adjacency rule there is unverified. Published near1 numbers are used as-is.`,
    });
    return;
  }
  const want = [adj.lower, adj.upper].sort().join(',');
  const got = [...near1.numbers].sort().join(',');
  if (want !== got) {
    issues.push({
      severity: 'error',
      code: 'near1_not_adjacent',
      category: 'near1',
      message: `near1 should be ${want}, got ${got}.`,
    });
  }
}
