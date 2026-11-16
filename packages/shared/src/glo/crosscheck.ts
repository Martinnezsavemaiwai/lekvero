import type { DrawResult } from '../draw';
import { checkTicket } from '../matcher';
import type { PrizeCategoryCode } from '../prize-categories';
import { categoryFromGloRewardLabel } from './checker-labels';
import type { GloCheckEnvelope } from './schema';

export interface CrosscheckMismatch {
  readonly number: string;
  readonly ours: PrizeCategoryCode[];
  readonly glo: PrizeCategoryCode[] | 'unmapped_label';
}

export interface CrosscheckResult {
  /** True only if every checked number agrees AND at least one number was checked. */
  readonly agrees: boolean;
  readonly checkedNumbers: string[];
  readonly mismatches: CrosscheckMismatch[];
}

/**
 * Compare our matching engine with GLO's own checker verdicts for the same
 * draw. Used as OFFICIAL_EVIDENCE when promoting a result to VERIFIED.
 * Verdicts for a different draw date, or with unknown reward labels, count as
 * disagreement (never silently ignored).
 */
export function crosscheckWithGloChecker(
  draw: DrawResult,
  envelopes: readonly GloCheckEnvelope[],
): CrosscheckResult {
  const mismatches: CrosscheckMismatch[] = [];
  const checkedNumbers: string[] = [];
  for (const env of envelopes) {
    for (const v of env.response.result) {
      checkedNumbers.push(v.number);
      const ours = checkTicket(draw, v.number)
        .wins.map((w) => w.category)
        .sort();
      if (v.date !== draw.drawDate) {
        mismatches.push({ number: v.number, ours, glo: [] });
        continue;
      }
      const mapped = v.status_data.map((s) => categoryFromGloRewardLabel(s.reward));
      if (mapped.some((m) => m === undefined)) {
        mismatches.push({ number: v.number, ours, glo: 'unmapped_label' });
        continue;
      }
      const glo = (mapped as PrizeCategoryCode[]).sort();
      const winnerFlagAgrees = (v.statusType === 1) === ours.length > 0;
      if (!winnerFlagAgrees || ours.join(',') !== glo.join(',')) {
        mismatches.push({ number: v.number, ours, glo });
      }
    }
  }
  return {
    agrees: checkedNumbers.length > 0 && mismatches.length === 0,
    checkedNumbers,
    mismatches,
  };
}
