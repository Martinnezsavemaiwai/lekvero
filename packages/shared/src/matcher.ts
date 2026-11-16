import type { DrawResult } from './draw';
import { bahtToSatang, satangToBaht } from './money';
import { PRIZE_CATEGORIES, matches } from './prize-categories';
import type { MatchType, PrizeCategoryCode } from './prize-categories';
import { categoriesOf } from './prize-structures';
import type { PrizeStructureCode } from './prize-structures';
import { parseTicketNumber } from './ticket';
import type { TicketNumber } from './ticket';

export interface Win {
  readonly category: PrizeCategoryCode;
  readonly matchType: MatchType;
  /** The published prize number that matched (2, 3 or 6 digits). */
  readonly matchedNumber: string;
  /** Amount per ticket for this draw, or null if the draw has no verified amount. */
  readonly amountBaht: string | null;
}

export interface CheckResult {
  readonly ticket: TicketNumber;
  readonly drawDate: string;
  readonly prizeStructure: PrizeStructureCode;
  readonly isWinner: boolean;
  /** Every winning category, ordered by category sort order. Prizes are cumulative. */
  readonly wins: readonly Win[];
  /**
   * Sum of all win amounts, or null if any winning category's amount is
   * unknown for this draw. "0.00" when there are no wins.
   */
  readonly totalAmountBaht: string | null;
}

/**
 * Check one ticket against one draw.
 *
 * Pure function: no database, no network, no clock. Uses only the categories
 * of the draw's own prize structure and only the numbers and amounts the draw
 * contains. Assumes `draw` already passed `validateDrawResult`.
 *
 * @throws InvalidTicketNumberError when `ticket` is not exactly six digits.
 */
export function checkTicket(draw: DrawResult, ticket: unknown): CheckResult {
  const t = parseTicketNumber(ticket);
  const allowed = new Set(categoriesOf(draw.prizeStructure));
  const wins: Win[] = [];

  for (const prize of draw.prizes) {
    if (!allowed.has(prize.category)) continue;
    const def = PRIZE_CATEGORIES[prize.category];
    for (const n of prize.numbers) {
      if (n.length === def.digits && matches(def.matchType, t, n)) {
        wins.push({
          category: prize.category,
          matchType: def.matchType,
          matchedNumber: n,
          amountBaht: prize.amountBaht,
        });
      }
    }
  }
  wins.sort(
    (a, b) => PRIZE_CATEGORIES[a.category].sortOrder - PRIZE_CATEGORIES[b.category].sortOrder,
  );

  let total: bigint | null = 0n;
  for (const w of wins) {
    total = total === null || w.amountBaht === null ? null : total + bahtToSatang(w.amountBaht);
  }

  return {
    ticket: t,
    drawDate: draw.drawDate,
    prizeStructure: draw.prizeStructure,
    isWinner: wins.length > 0,
    wins,
    totalAmountBaht: total === null ? null : satangToBaht(total),
  };
}

/** Check several tickets against one draw (convenience; same semantics as checkTicket). */
export function checkTickets(draw: DrawResult, tickets: readonly unknown[]): CheckResult[] {
  return tickets.map((t) => checkTicket(draw, t));
}
