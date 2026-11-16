import type { PrizeCategoryCode } from '../prize-categories';

/**
 * Reward labels returned by GLO's own checker (getcheckLotteryResult), mapped
 * to our category codes. ONLY labels actually observed in archived responses
 * are listed; anything else returns undefined so callers fail loudly instead
 * of guessing.
 */
const OBSERVED_LABELS: Readonly<Record<string, PrizeCategoryCode>> = Object.freeze({
  'รางวัลที่ 1': 'first',
  'รางวัลข้างเคียงรางวัลที่ 1': 'near1',
  'รางวัลเลขท้าย 2 ตัว': 'last2',
});

export function categoryFromGloRewardLabel(label: string): PrizeCategoryCode | undefined {
  return OBSERVED_LABELS[label];
}
