import { describe, expect, it } from 'vitest';
import { InvalidTicketNumberError, checkTicket, checkTickets, validateDrawResult } from '../src';
import type { DrawResult } from '../src';
import { legacyDraw, modernDraw } from './helpers/draws';

const cats = (draw: DrawResult, t: string) => checkTicket(draw, t).wins.map((w) => w.category);

describe('test draws are themselves valid', () => {
  it('modern and legacy synthetic draws pass validation', () => {
    expect(validateDrawResult(modernDraw()).issues).toEqual([]);
    expect(validateDrawResult(legacyDraw()).issues).toEqual([]);
  });
});

describe('checkTicket — modern structure', () => {
  const draw = modernDraw();

  it('first prize, with amount', () => {
    const r = checkTicket(draw, '123456');
    // 123456 also ends in "456" (last3b) — prizes are cumulative.
    expect(r.wins.map((w) => w.category)).toEqual(['first', 'last3b']);
    expect(r.totalAmountBaht).toBe('6004000.00');
    expect(r.isWinner).toBe(true);
  });

  it('adjacent numbers win near1 only', () => {
    expect(cats(draw, '123455')).toEqual(['near1']);
    expect(cats(draw, '123457')).toEqual(['near1']);
    expect(cats(draw, '123458')).toEqual([]);
  });

  it('returns ALL applicable categories, not just the first', () => {
    // second "222222": prefix "222"? no (last3f = 111, 079); suffix "222" → last3b; suffix "22" → last2
    const r = checkTicket(draw, '222222');
    expect(r.wins.map((w) => w.category)).toEqual(['second', 'last3b', 'last2']);
    expect(r.totalAmountBaht).toBe('206000.00');
  });

  it('distinguishes prefix (last3f) from suffix (last3b)', () => {
    expect(cats(draw, '111000')).toEqual(['last3f']);
    expect(cats(draw, '000111')).toEqual([]);
    expect(cats(draw, '000222')).toEqual(['last3b', 'last2']);
    expect(cats(draw, '222000')).toEqual([]);
  });

  it('preserves leading zeros', () => {
    expect(cats(draw, '079999')).toEqual(['last3f']);
    expect(cats(draw, '790999')).toEqual([]);
  });

  it('non-winner', () => {
    const r = checkTicket(draw, '987650');
    expect(r).toMatchObject({ isWinner: false, wins: [], totalAmountBaht: '0.00' });
  });

  it('rejects invalid tickets', () => {
    expect(() => checkTicket(draw, 123456)).toThrow(InvalidTicketNumberError);
    expect(() => checkTicket(draw, '12345')).toThrow(InvalidTicketNumberError);
  });

  it('checkTickets keeps input order', () => {
    expect(checkTickets(draw, ['987650', '123455']).map((r) => r.isWinner)).toEqual([false, true]);
  });
});

describe('checkTicket — legacy structure', () => {
  const draw = legacyDraw();

  it('has four last-3 numbers and no first-3 category', () => {
    expect(cats(draw, '000333')).toEqual(['last3b']);
    expect(cats(draw, '111000')).toEqual([]); // "111" is a last3b number, never a prefix match
    expect(cats(draw, '000111')).toEqual(['last3b']);
  });

  it('ignores a stray last3f block that is not part of the structure', () => {
    const withStray: DrawResult = {
      ...draw,
      prizes: [...draw.prizes, { category: 'last3f', numbers: ['999'], amountBaht: null }],
    };
    expect(cats(withStray, '999000')).toEqual([]);
    expect(validateDrawResult(withStray).ok).toBe(false);
  });

  it('never assumes amounts: unknown amounts give a null total', () => {
    const r = checkTicket(draw, '123456');
    expect(r.wins.map((w) => w.category)).toEqual(['first', 'last3b']);
    expect(r.wins.every((w) => w.amountBaht === null)).toBe(true);
    expect(r.totalAmountBaht).toBeNull();
  });
});

describe('amounts are per-draw data', () => {
  it('a modern draw without amounts reports null amounts (no defaults)', () => {
    const r = checkTicket(modernDraw({ amounts: false }), '123456');
    expect(r.isWinner).toBe(true);
    expect(r.totalAmountBaht).toBeNull();
  });
});

describe('boundary first-prize numbers', () => {
  it('first = 000000 uses the published near1 numbers as-is', () => {
    const draw = modernDraw({ first: '000000', near1: ['999999', '000001'] });
    expect(cats(draw, '000000')).toEqual(['first']);
    expect(cats(draw, '999999')).toEqual(['near1']);
    expect(cats(draw, '000001')).toEqual(['near1']);
    expect(cats(draw, '000002')).toEqual([]);
    const report = validateDrawResult(draw);
    expect(report.ok).toBe(true);
    expect(report.issues.map((i) => i.code)).toEqual(['near1_boundary_unverified']);
  });

  it('first = 999999 with only one published neighbour is accepted with a warning', () => {
    const draw = modernDraw({ first: '999999', near1: ['999998'] });
    expect(cats(draw, '999998')).toEqual(['near1']);
    expect(cats(draw, '000000')).toEqual([]); // not published → not a win
    expect(validateDrawResult(draw).ok).toBe(true);
  });
});
