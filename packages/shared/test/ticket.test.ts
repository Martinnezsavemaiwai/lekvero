import { describe, expect, it } from 'vitest';
import { InvalidTicketNumberError, parseTicketNumber } from '../src';

describe('parseTicketNumber', () => {
  it.each(['000000', '000079', '012345', '999999', '645654'])('accepts %s unchanged', (s) => {
    expect(parseTicketNumber(s)).toBe(s);
  });

  it.each([
    ['JS number (loses leading zeros)', 79],
    ['JS number six digits', 123456],
    ['five digits', '12345'],
    ['seven digits', '1234567'],
    ['empty', ''],
    ['leading space', ' 123456'],
    ['trailing newline', '123456\n'],
    ['letter', '12345a'],
    ['sign', '+12345'],
    ['decimal', '1234.5'],
    ['Thai digits', '๑๒๓๔๕๖'],
    ['full-width digits', '１２３４５６'],
    ['null', null],
    ['undefined', undefined],
  ])('rejects %s', (_label, input) => {
    expect(() => parseTicketNumber(input)).toThrow(InvalidTicketNumberError);
  });
});
