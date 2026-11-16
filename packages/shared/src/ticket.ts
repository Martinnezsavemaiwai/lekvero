import { z } from 'zod';

/**
 * A Thai Government Lottery ticket number: exactly six ASCII digits, kept as a
 * string so leading zeros survive ("000079" ≠ 79).
 */
export const TicketNumberSchema = z
  .string()
  .regex(/^[0-9]{6}$/, 'Ticket number must be exactly six digits (0-9), e.g. "012345".')
  .brand<'TicketNumber'>();

export type TicketNumber = z.infer<typeof TicketNumberSchema>;

export class InvalidTicketNumberError extends Error {
  override readonly name = 'InvalidTicketNumberError';
  constructor(readonly input: unknown) {
    super(
      `Invalid ticket number: ${JSON.stringify(input)}. Expected a string of exactly six digits.`,
    );
  }
}

/** Parse untrusted input into a TicketNumber. Rejects JS numbers on purpose (they lose leading zeros). */
export function parseTicketNumber(input: unknown): TicketNumber {
  const result = TicketNumberSchema.safeParse(input);
  if (!result.success) throw new InvalidTicketNumberError(input);
  return result.data;
}
