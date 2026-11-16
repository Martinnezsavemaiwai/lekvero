import { describe, expect, it } from 'vitest';
import { adjacentNumbers, bahtToSatang, satangToBaht } from '../src';

describe('money', () => {
  it('converts exactly', () => {
    expect(bahtToSatang('6000000.00')).toBe(600000000n);
    expect(bahtToSatang('0.1')).toBe(10n);
    expect(bahtToSatang('2000')).toBe(200000n);
    expect(satangToBaht(600000000n + 200000n)).toBe('6002000.00');
    expect(satangToBaht(5n)).toBe('0.05');
  });
  it.each(['-1', '1.234', 'abc', '01', ''])('rejects %j', (s) => {
    expect(() => bahtToSatang(s)).toThrow();
  });
});

describe('adjacentNumbers', () => {
  it('handles the general case and preserves leading zeros', () => {
    expect(adjacentNumbers('253603')).toEqual({ lower: '253602', upper: '253604', wraps: false });
    expect(adjacentNumbers('000009')).toEqual({ lower: '000008', upper: '000010', wraps: false });
    expect(adjacentNumbers('000001')).toEqual({ lower: '000000', upper: '000002', wraps: false });
    expect(adjacentNumbers('999998')).toEqual({ lower: '999997', upper: '999999', wraps: false });
  });
  it('flags wrap-around at the boundaries (assumed, unverified rule)', () => {
    expect(adjacentNumbers('000000')).toEqual({ lower: '999999', upper: '000001', wraps: true });
    expect(adjacentNumbers('999999')).toEqual({ lower: '999998', upper: '000000', wraps: true });
  });
});
