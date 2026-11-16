import { z } from 'zod';
import { BahtAmountSchema } from '../money';

/**
 * Zod contracts for the GLO public API, derived ONLY from responses archived
 * in fixtures/glo/v1 (see docs/research/data-sources.md §3). Objects are
 * "loose": unknown extra keys are tolerated (and can be reported via
 * `unknownKeys`) because GLO has added fields before (e.g. `n3`).
 */

export const GloNumberEntrySchema = z.object({
  round: z.number().int().nonnegative(),
  value: z.string().regex(/^[0-9]+$/),
});

export const GloPrizeBlockSchema = z.looseObject({
  price: BahtAmountSchema,
  number: z.array(GloNumberEntrySchema),
});

export const GloPrizeDataSchema = z.looseObject({
  first: GloPrizeBlockSchema,
  second: GloPrizeBlockSchema,
  third: GloPrizeBlockSchema,
  fourth: GloPrizeBlockSchema,
  fifth: GloPrizeBlockSchema,
  last2: GloPrizeBlockSchema,
  last3f: GloPrizeBlockSchema,
  last3b: GloPrizeBlockSchema,
  near1: GloPrizeBlockSchema,
});

/** The draw object shared by getLatestLottery.response and getLotteryResult.response.result */
export const GloDrawSchema = z.looseObject({
  date: z.iso.date(),
  youtube_url: z.string().nullable().optional(),
  pdf_url: z.string().nullable().optional(),
  /** Meaning not confirmed ("ชุดที่" per catalogue). Stored raw, never interpreted. */
  period: z.array(z.number().int()).nullable().optional(),
  remark: z.unknown().optional(),
  status: z.number().int().optional(),
  sheetId: z.string().optional(),
  data: GloPrizeDataSchema,
  /** Separate N3 product; out of scope, preserved only as raw metadata. */
  n3: z.unknown().optional(),
});
export type GloDraw = z.infer<typeof GloDrawSchema>;

const envelope = {
  statusMessage: z.string(),
  statusCode: z.literal(200),
  message: z.unknown(),
  status: z.literal(true),
};

const GloResponseStatusSchema = z.looseObject({
  operation: z.string(),
  status: z.literal('Success'),
  code: z.string(),
});

/** POST /api/lottery/getLatestLottery */
export const GloLatestEnvelopeSchema = z.looseObject({
  ...envelope,
  response: GloDrawSchema.extend({
    displayDate: z.object({ date: z.string(), month: z.string(), year: z.string() }).optional(),
  }),
});

/**
 * POST /api/checking/getLotteryResult
 * `response: null` means "no data for that date". It does NOT prove there was no draw.
 */
export const GloByDateEnvelopeSchema = z.looseObject({
  ...envelope,
  response: z
    .looseObject({ responseStatus: GloResponseStatusSchema, result: GloDrawSchema })
    .nullable(),
});

/** POST /api/checking/getcheckLotteryResult */
export const GloCheckEnvelopeSchema = z.looseObject({
  ...envelope,
  response: z.looseObject({
    responseStatus: GloResponseStatusSchema,
    result: z.array(
      z.looseObject({
        date: z.iso.date(),
        number: z.string().regex(/^[0-9]{6}$/),
        /** Observed: 1 = win, 2 = no win. Other values unknown. */
        statusType: z.number().int(),
        status_data: z.array(z.looseObject({ reward: z.string() })),
      }),
    ),
  }),
});
export type GloCheckEnvelope = z.infer<typeof GloCheckEnvelopeSchema>;

const KNOWN_DRAW_KEYS = new Set([
  'date',
  'youtube_url',
  'pdf_url',
  'period',
  'remark',
  'status',
  'sheetId',
  'data',
  'n3',
  'displayDate',
]);

/** Keys present on a raw draw object that this contract does not know about (for drift alerts). */
export function unknownDrawKeys(raw: Record<string, unknown>): string[] {
  return Object.keys(raw).filter((k) => !KNOWN_DRAW_KEYS.has(k));
}
