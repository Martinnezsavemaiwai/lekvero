import { z } from 'zod';

/** Baht amount as a non-negative decimal string with up to two fraction digits, e.g. "6000000.00". */
export const BahtAmountSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)(\.[0-9]{1,2})?$/, 'Amount must be a non-negative decimal string');

/** Exact conversion to satang (1/100 baht) as bigint, avoiding floating-point error. */
export function bahtToSatang(amount: string): bigint {
  const parsed = BahtAmountSchema.parse(amount);
  const [whole, frac = ''] = parsed.split('.');
  return BigInt(whole ?? '0') * 100n + BigInt(frac.padEnd(2, '0'));
}

export function satangToBaht(satang: bigint): string {
  if (satang < 0n) throw new RangeError('Negative amounts are not supported');
  const whole = satang / 100n;
  const frac = (satang % 100n).toString().padStart(2, '0');
  return `${whole}.${frac}`;
}
