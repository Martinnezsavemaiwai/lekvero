import { describe, expect, it } from 'vitest';
import {
  GloByDateEnvelopeSchema,
  GloCheckEnvelopeSchema,
  crosscheckWithGloChecker,
  mapGloDraw,
} from '../src';
import type { GloCheckEnvelope } from '../src';
import { readFixture } from './helpers/fixtures';

const draw = mapGloDraw(
  GloByDateEnvelopeSchema.parse(readFixture('live/result-by-date/2024-03-01.json')).response!
    .result,
);
const winners = GloCheckEnvelopeSchema.parse(readFixture('live/check/2024-03-01_winners.json'));
const loser = GloCheckEnvelopeSchema.parse(readFixture('live/check/2024-03-01_nonwinner.json'));

const withVerdict = (
  env: GloCheckEnvelope,
  patch: Partial<GloCheckEnvelope['response']['result'][number]>,
): GloCheckEnvelope => ({
  ...env,
  response: {
    ...env.response,
    result: env.response.result.map((r, i) => (i === 0 ? { ...r, ...patch } : r)),
  },
});

describe('crosscheckWithGloChecker', () => {
  it('agrees with the archived official checker for 2024-03-01', () => {
    const r = crosscheckWithGloChecker(draw, [winners, loser]);
    expect(r).toEqual({
      agrees: true,
      checkedNumbers: ['253603', '000079', '253602', '123456'],
      mismatches: [],
    });
  });
  it('no verdicts is not agreement', () => {
    expect(crosscheckWithGloChecker(draw, []).agrees).toBe(false);
  });
  it('detects a disagreement', () => {
    const r = crosscheckWithGloChecker(draw, [
      withVerdict(winners, { status_data: [{ reward: 'รางวัลเลขท้าย 2 ตัว' }] }),
    ]);
    expect(r.agrees).toBe(false);
    expect(r.mismatches[0]).toMatchObject({ number: '253603', ours: ['first'], glo: ['last2'] });
  });
  it('treats an unknown GLO label as disagreement', () => {
    const r = crosscheckWithGloChecker(draw, [
      withVerdict(winners, { status_data: [{ reward: 'unknown label' }] }),
    ]);
    expect(r.mismatches[0]?.glo).toBe('unmapped_label');
  });
  it('treats a verdict for another draw date as disagreement', () => {
    expect(
      crosscheckWithGloChecker(draw, [withVerdict(winners, { date: '2024-03-16' })]).agrees,
    ).toBe(false);
  });
});
