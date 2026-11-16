import type { DrawResult, Prize } from '../../src';

/**
 * SYNTHETIC test draws (hand-built). Not GLO data. Numbers are chosen to
 * exercise specific matching paths; amounts are arbitrary test values.
 */
const sixDigit = (start: number, count: number, step = 7919) =>
  Array.from({ length: count }, (_, i) => String((start + i * step) % 1_000_000).padStart(6, '0'));

function base(first: string, near1: string[], amount: string | null): Prize[] {
  return [
    { category: 'first', numbers: [first], amountBaht: amount && '6000000.00' },
    { category: 'near1', numbers: near1, amountBaht: amount && '100000.00' },
    {
      category: 'second',
      numbers: ['111111', '222222', '333333', '444444', '555555'],
      amountBaht: amount && '200000.00',
    },
    { category: 'third', numbers: sixDigit(600001, 10), amountBaht: amount && '80000.00' },
    { category: 'fourth', numbers: sixDigit(700001, 50), amountBaht: amount && '40000.00' },
    { category: 'fifth', numbers: sixDigit(800001, 100, 1009), amountBaht: amount && '20000.00' },
  ];
}

export function modernDraw(
  opts: { first?: string; near1?: string[]; amounts?: boolean } = {},
): DrawResult {
  const first = opts.first ?? '123456';
  const amount = opts.amounts === false ? null : 'y';
  return {
    drawDate: '2099-01-01',
    prizeStructure: 'MODERN_FRONT3_BACK3',
    prizes: [
      ...base(first, opts.near1 ?? ['123455', '123457'], amount),
      { category: 'last3f', numbers: ['111', '079'], amountBaht: amount && '4000.00' },
      { category: 'last3b', numbers: ['222', '456'], amountBaht: amount && '4000.00' },
      { category: 'last2', numbers: ['22'], amountBaht: amount && '2000.00' },
    ],
  };
}

export function legacyDraw(): DrawResult {
  return {
    drawDate: '2099-01-16',
    prizeStructure: 'LEGACY_LAST3X4',
    prizes: [
      ...base('123456', ['123455', '123457'], null),
      { category: 'last3b', numbers: ['111', '222', '333', '456'], amountBaht: null },
      { category: 'last2', numbers: ['22'], amountBaht: null },
    ],
  };
}
