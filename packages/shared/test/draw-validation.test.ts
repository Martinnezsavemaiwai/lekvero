import { describe, expect, it } from 'vitest';
import { DrawResultSchema, validateDrawResult } from '../src';
import type { DrawResult, Prize } from '../src';
import { modernDraw } from './helpers/draws';

const codes = (d: DrawResult) => validateDrawResult(d).issues.map((i) => i.code);
const edit = (d: DrawResult, cat: Prize['category'], f: (p: Prize) => Prize): DrawResult => ({
  ...d,
  prizes: d.prizes.map((p) => (p.category === cat ? f(p) : p)),
});

describe('validateDrawResult', () => {
  const ok = modernDraw();

  it('detects a missing category', () => {
    expect(codes({ ...ok, prizes: ok.prizes.filter((p) => p.category !== 'fifth') })).toEqual([
      'missing_category',
    ]);
  });
  it('detects a wrong count', () => {
    expect(codes(edit(ok, 'fourth', (p) => ({ ...p, numbers: p.numbers.slice(1) })))).toEqual([
      'wrong_count',
    ]);
  });
  it('detects a wrong digit length', () => {
    expect(
      codes(edit(ok, 'second', (p) => ({ ...p, numbers: ['11111', ...p.numbers.slice(1)] }))),
    ).toEqual(['wrong_digit_length']);
  });
  it('detects duplicates', () => {
    expect(
      codes(edit(ok, 'second', (p) => ({ ...p, numbers: ['111111', ...p.numbers.slice(0, 4)] }))),
    ).toEqual(['duplicate_number']);
  });
  it('detects a duplicated category', () => {
    expect(codes({ ...ok, prizes: [...ok.prizes, ok.prizes[0]!] })).toEqual(['duplicate_category']);
  });
  it('detects near1 that is not adjacent', () => {
    expect(codes(modernDraw({ near1: ['123455', '123458'] }))).toEqual(['near1_not_adjacent']);
  });
  it('schema rejects non-digit numbers and bad dates', () => {
    expect(DrawResultSchema.safeParse({ ...ok, drawDate: '2024-02-30' }).success).toBe(false);
    expect(
      DrawResultSchema.safeParse(edit(ok, 'last2', (p) => ({ ...p, numbers: ['2a'] }))).success,
    ).toBe(false);
  });
});
