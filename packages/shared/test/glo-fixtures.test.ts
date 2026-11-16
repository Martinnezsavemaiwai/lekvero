/**
 * Golden tests against ARCHIVED official GLO responses (fixtures/glo/v1).
 * No network access.
 */
import { describe, expect, it } from 'vitest';
import {
  GloByDateEnvelopeSchema,
  GloCheckEnvelopeSchema,
  GloLatestEnvelopeSchema,
  PRIZE_CATEGORIES,
  categoryFromGloRewardLabel,
  checkTicket,
  mapGloDraw,
  unknownDrawKeys,
  validateDrawResult,
} from '../src';
import type { DrawResult, GloDraw, PrizeStructureCode } from '../src';
import { manifest, readFixture, readFixtureText, sha256 } from './helpers/fixtures';

const EXPECTED_STRUCTURE: Record<string, PrizeStructureCode> = {
  '2011-02-01': 'LEGACY_LAST3X4',
  '2013-02-01': 'LEGACY_LAST3X4',
  '2015-01-16': 'LEGACY_LAST3X4',
  '2020-01-17': 'MODERN_FRONT3_BACK3',
  '2024-03-01': 'MODERN_FRONT3_BACK3',
  '2024-12-16': 'MODERN_FRONT3_BACK3',
  '2025-01-17': 'MODERN_FRONT3_BACK3',
};
const NULL_DATES = [
  '1995-01-16',
  '2006-02-01',
  '2007-01-16',
  '2008-02-01',
  '2010-01-16',
  '2020-01-16',
  '2024-03-05',
  '2024-12-30',
];

function loadByDate(date: string): GloDraw {
  const env = GloByDateEnvelopeSchema.parse(readFixture(`live/result-by-date/${date}.json`));
  if (!env.response) throw new Error(`fixture ${date} unexpectedly null`);
  return env.response.result;
}

function loadLatest(): GloDraw {
  return GloLatestEnvelopeSchema.parse(readFixture('live/latest/2026-11-16.json')).response;
}

function allDraws(): Array<[string, DrawResult]> {
  return [
    ...Object.keys(EXPECTED_STRUCTURE).map((d): [string, DrawResult] => [
      d,
      mapGloDraw(loadByDate(d)),
    ]),
    ['2026-11-16', mapGloDraw(loadLatest())],
  ];
}

describe('fixture integrity', () => {
  it('every file matches its manifest SHA-256', () => {
    const files = manifest().files;
    expect(files.length).toBeGreaterThan(20);
    for (const f of files) expect(sha256(f.path), f.path).toBe(f.sha256);
  });
});

describe('GLO contracts accept every archived live response', () => {
  it.each(Object.entries(EXPECTED_STRUCTURE))('%s maps to %s and validates', (date, structure) => {
    const draw = mapGloDraw(loadByDate(date));
    expect(draw.drawDate).toBe(date);
    expect(draw.prizeStructure).toBe(structure);
    expect(validateDrawResult(draw)).toEqual({ ok: true, issues: [] });
  });

  it('latest (2026-11-16) parses; n3 is preserved raw but not mapped', () => {
    const raw = loadLatest();
    expect(raw.n3).toBeTruthy();
    expect(unknownDrawKeys(raw)).toEqual([]);
    const draw = mapGloDraw(raw);
    expect(draw.prizeStructure).toBe('MODERN_FRONT3_BACK3');
    expect(validateDrawResult(draw).ok).toBe(true);
    expect(draw.prizes.find((p) => p.category === 'first')?.numbers).toEqual(['645654']);
  });

  it.each(NULL_DATES)('%s → response null (no data; not proof of no draw)', (date) => {
    expect(
      GloByDateEnvelopeSchema.parse(readFixture(`live/result-by-date/${date}.null.json`)).response,
    ).toBeNull();
  });

  it('legacy amounts are omitted by default and only kept on explicit request', () => {
    const raw = loadByDate('2011-02-01');
    expect(mapGloDraw(raw).prizes.every((p) => p.amountBaht === null)).toBe(true);
    expect(mapGloDraw(raw, { legacyAmounts: 'reported' }).prizes[0]?.amountBaht).toBe('6000000.00');
  });

  it('numbers are ordered by GLO draw order ("round"), not array order', () => {
    const raw = loadByDate('2024-03-01');
    const second = mapGloDraw(raw).prizes.find((p) => p.category === 'second')!;
    const byRound = [...raw.data.second.number]
      .sort((a, b) => a.round - b.round)
      .map((n) => n.value);
    expect(second.numbers).toEqual(byRound);
  });
});

describe('self-consistency: every published number wins its own category', () => {
  it.each(allDraws())('%s', (_date, draw) => {
    for (const prize of draw.prizes) {
      const def = PRIZE_CATEGORIES[prize.category];
      for (const n of prize.numbers) {
        const ticket =
          def.matchType === 'EXACT6'
            ? n
            : def.matchType === 'PREFIX3'
              ? `${n}000`
              : def.matchType === 'SUFFIX3'
                ? `000${n}`
                : `0000${n}`;
        const cats = checkTicket(draw, ticket).wins.map((w) => w.category);
        expect(cats, `${prize.category} ${n}`).toContain(prize.category);
      }
    }
  });
});

describe('engine agrees with archived GLO checker verdicts (2024-03-01)', () => {
  const draw = mapGloDraw(loadByDate('2024-03-01'));
  const verdicts = [
    'live/check/2024-03-01_winners.json',
    'live/check/2024-03-01_nonwinner.json',
  ].flatMap((f) => GloCheckEnvelopeSchema.parse(readFixture(f)).response.result);

  it('covers 4 numbers', () => expect(verdicts).toHaveLength(4));

  it.each(verdicts.map((v) => [v.number, v] as const))('%s', (_n, v) => {
    const ours = checkTicket(draw, v.number);
    expect(v.date).toBe(draw.drawDate);
    expect(ours.isWinner).toBe(v.statusType === 1);
    const theirs = v.status_data.map((s) => {
      const c = categoryFromGloRewardLabel(s.reward);
      if (!c) throw new Error(`Unobserved GLO reward label: ${s.reward}`);
      return c;
    });
    expect(ours.wins.map((w) => w.category).sort()).toEqual(theirs.sort());
  });
});

describe('synthetic malformed fixtures are rejected', () => {
  const parseThenValidate = (rel: string) => {
    const env = GloByDateEnvelopeSchema.safeParse(readFixture(rel));
    if (!env.success) return 'schema';
    return validateDrawResult(mapGloDraw(env.data.response!.result)).issues.map((i) => i.code);
  };

  it.each([
    ['missing-first.json', 'schema'],
    ['numeric-value.json', 'schema'],
    ['bad-price.json', 'schema'],
    ['status-false.json', 'schema'],
    ['five-digit-number.json', ['wrong_digit_length']],
    ['wrong-count-fourth.json', ['wrong_count']],
    ['duplicate-in-fifth.json', ['duplicate_number']],
    ['near1-not-adjacent.json', ['near1_not_adjacent']],
  ])('%s → %j', (file, expected) => {
    expect(parseThenValidate(`synthetic/malformed/${file}`)).toEqual(expected);
  });

  it('truncated JSON fails to parse', () => {
    expect(() => JSON.parse(readFixtureText('synthetic/malformed/truncated.json.txt'))).toThrow(
      SyntaxError,
    );
  });
});
