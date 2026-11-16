/**
 * Property-based tests (fast-check). Draws are randomly generated (synthetic).
 * The main property is a DIFFERENTIAL test against an independent reference
 * implementation that uses integer arithmetic instead of string slicing.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  PRIZE_CATEGORIES,
  PRIZE_STRUCTURES,
  adjacentNumbers,
  bahtToSatang,
  checkTicket,
  validateDrawResult,
} from '../src';
import type { DrawResult, PrizeCategoryCode, PrizeStructureCode } from '../src';

const pad = (n: number, w: number) => n.toString().padStart(w, '0');
const ticketArb = fc.integer({ min: 0, max: 999_999 }).map((n) => pad(n, 6));

const drawArb: fc.Arbitrary<DrawResult> = fc
  .record({
    structure: fc.constantFrom<PrizeStructureCode>('LEGACY_LAST3X4', 'MODERN_FRONT3_BACK3'),
    // 166 unique six-digit numbers: 1 first + 5 + 10 + 50 + 100; avoid boundary firsts.
    six: fc.uniqueArray(fc.integer({ min: 2, max: 999_997 }), { minLength: 166, maxLength: 166 }),
    three: fc.uniqueArray(fc.integer({ min: 0, max: 999 }), { minLength: 4, maxLength: 4 }),
    two: fc.integer({ min: 0, max: 99 }),
    withAmounts: fc.boolean(),
  })
  .filter(({ six }) => {
    const first = six[0]!;
    return !six.includes(first - 1) && !six.includes(first + 1);
  })
  .map(({ structure, six, three, two, withAmounts }) => {
    const s = six.map((n) => pad(n, 6));
    const first = s[0]!;
    const adj = adjacentNumbers(first);
    const amt = (v: string) => (withAmounts ? v : null);
    const t = three.map((n) => pad(n, 3));
    const threes: DrawResult['prizes'] =
      structure === 'MODERN_FRONT3_BACK3'
        ? [
            { category: 'last3f', numbers: t.slice(0, 2), amountBaht: amt('4000.00') },
            { category: 'last3b', numbers: t.slice(2, 4), amountBaht: amt('4000.00') },
          ]
        : [{ category: 'last3b', numbers: t, amountBaht: amt('4000.00') }];
    return {
      drawDate: '2099-12-31',
      prizeStructure: structure,
      prizes: [
        { category: 'first', numbers: [first], amountBaht: amt('6000000.00') },
        { category: 'near1', numbers: [adj.lower, adj.upper], amountBaht: amt('100000.00') },
        { category: 'second', numbers: s.slice(1, 6), amountBaht: amt('200000.00') },
        { category: 'third', numbers: s.slice(6, 16), amountBaht: amt('80000.00') },
        { category: 'fourth', numbers: s.slice(16, 66), amountBaht: amt('40000.00') },
        { category: 'fifth', numbers: s.slice(66, 166), amountBaht: amt('20000.00') },
        ...threes,
        { category: 'last2', numbers: [pad(two, 2)], amountBaht: amt('2000.00') },
      ],
    } satisfies DrawResult;
  });

/** Independent reference: integer arithmetic, structure-driven category list. */
function referenceWins(draw: DrawResult, ticket: string): PrizeCategoryCode[] {
  const t = Number(ticket);
  const allowed = Object.keys(PRIZE_STRUCTURES[draw.prizeStructure].expectedCounts);
  const out: PrizeCategoryCode[] = [];
  for (const p of draw.prizes) {
    if (!allowed.includes(p.category)) continue;
    for (const n of p.numbers.map(Number)) {
      const hit =
        p.category === 'last3f'
          ? Math.floor(t / 1000) === n
          : p.category === 'last3b'
            ? t % 1000 === n
            : p.category === 'last2'
              ? t % 100 === n
              : t === n;
      if (hit) out.push(p.category);
    }
  }
  return out.sort((a, b) => PRIZE_CATEGORIES[a].sortOrder - PRIZE_CATEGORIES[b].sortOrder);
}

/** Tickets biased towards hitting prizes, so the property is not vacuous. */
const drawAndTicketArb = drawArb.chain((draw) => {
  const published = draw.prizes.flatMap((p) => p.numbers.map((n) => ({ cat: p.category, n })));
  const near = fc.constantFrom(...published).chain(({ cat, n }) => {
    const m = PRIZE_CATEGORIES[cat].matchType;
    if (m === 'EXACT6') return fc.constant(n);
    return fc.integer({ min: 0, max: 10 ** (6 - n.length) - 1 }).map((r) => {
      const rest = pad(r, 6 - n.length);
      return m === 'PREFIX3' ? n + rest : rest + n;
    });
  });
  return fc.tuple(fc.constant(draw), fc.oneof(ticketArb, near));
});

describe('matcher properties', () => {
  it('generated draws are valid', () => {
    fc.assert(
      fc.property(drawArb, (d) => validateDrawResult(d).ok),
      { numRuns: 100 },
    );
  });

  it('agrees with the independent reference implementation', () => {
    fc.assert(
      fc.property(drawAndTicketArb, ([draw, ticket]) => {
        expect(checkTicket(draw, ticket).wins.map((w) => w.category)).toEqual(
          referenceWins(draw, ticket),
        );
      }),
      { numRuns: 2000 },
    );
  });

  it('every published number wins its category (exact categories)', () => {
    fc.assert(
      fc.property(drawArb, (draw) => {
        for (const p of draw.prizes.filter(
          (x) => PRIZE_CATEGORIES[x.category].matchType === 'EXACT6',
        )) {
          for (const n of p.numbers) {
            expect(checkTicket(draw, n).wins.map((w) => w.category)).toContain(p.category);
          }
        }
      }),
      { numRuns: 50 },
    );
  });

  it('any ticket whose last two digits equal last2 wins last2', () => {
    fc.assert(
      fc.property(drawArb, fc.integer({ min: 0, max: 9999 }), (draw, head) => {
        const l2 = draw.prizes.find((p) => p.category === 'last2')!.numbers[0]!;
        const r = checkTicket(draw, pad(head, 4) + l2);
        expect(r.wins.map((w) => w.category)).toContain('last2');
      }),
    );
  });

  it('result does not depend on the order of published numbers', () => {
    fc.assert(
      fc.property(drawAndTicketArb, ([draw, ticket]) => {
        const reversed: DrawResult = {
          ...draw,
          prizes: [...draw.prizes]
            .reverse()
            .map((p) => ({ ...p, numbers: [...p.numbers].reverse() })),
        };
        expect(checkTicket(reversed, ticket)).toEqual(checkTicket(draw, ticket));
      }),
      { numRuns: 300 },
    );
  });

  it('leading zeros: the ticket is echoed unchanged and wins only via string semantics', () => {
    fc.assert(
      fc.property(drawArb, fc.integer({ min: 0, max: 99_999 }), (draw, n) => {
        const ticket = pad(n, 6); // always starts with "0"
        expect(checkTicket(draw, ticket).ticket).toBe(ticket);
      }),
    );
  });

  it('total equals the sum of win amounts, or null if any is unknown', () => {
    fc.assert(
      fc.property(drawAndTicketArb, ([draw, ticket]) => {
        const r = checkTicket(draw, ticket);
        if (r.wins.some((w) => w.amountBaht === null)) {
          expect(r.totalAmountBaht).toBeNull();
        } else {
          const sum = r.wins.reduce((s, w) => s + bahtToSatang(w.amountBaht!), 0n);
          expect(bahtToSatang(r.totalAmountBaht!)).toBe(sum);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('legacy draws never yield a last3f win', () => {
    fc.assert(
      fc.property(drawAndTicketArb, ([draw, ticket]) => {
        if (draw.prizeStructure !== 'LEGACY_LAST3X4') return;
        expect(checkTicket(draw, ticket).wins.some((w) => w.category === 'last3f')).toBe(false);
      }),
      { numRuns: 500 },
    );
  });
});
