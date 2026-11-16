import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type pg from 'pg';
import { PayloadTooLargeError, SensitiveDataError } from './errors';
import { MAX_RAW_PAYLOAD_BYTES, rawPayload, source } from './schema';
import { withTransaction } from './tx';

/**
 * Response headers worth keeping for provenance. Everything else is dropped —
 * in particular cookies, auth headers and WAF/session tokens are NEVER stored.
 */
export const ALLOWED_RESPONSE_HEADERS = new Set([
  'date',
  'content-type',
  'content-length',
  'cache-control',
  'etag',
  'last-modified',
  'expires',
  'age',
  'x-cache',
]);

const SENSITIVE_KEY = /(pass(word)?|secret|token|api[-_]?key|auth|cookie|session|credential)/i;

export interface RawPayloadInput {
  readonly sourceCode: string;
  readonly endpoint: string;
  readonly requestMethod: 'GET' | 'POST';
  /** Request body / query. Must not contain credentials (rejected if keys look sensitive). */
  readonly requestParams: Record<string, unknown> | null;
  readonly httpStatus: number;
  readonly fetchedAt: Date;
  readonly contentType?: string | null;
  /** Raw response headers; filtered through ALLOWED_RESPONSE_HEADERS. */
  readonly responseHeaders?: Record<string, string>;
  /** Exact response bytes. */
  readonly body: Uint8Array;
  readonly provenance: string;
  readonly importRunId?: number | null;
}

export interface PreparedRawPayload {
  readonly bodyBytes: Buffer;
  readonly sha256: Buffer;
  readonly byteSize: number;
  readonly bodyJson: unknown;
  readonly responseHeaders: Record<string, string>;
  readonly droppedHeaderNames: string[];
  readonly requestParams: Record<string, unknown>;
}

function assertNoSensitiveKeys(value: unknown, path = 'requestParams'): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoSensitiveKeys(v, `${path}[${i}]`));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(k)) {
        throw new SensitiveDataError(`Refusing to store ${path}.${k}: looks like a credential.`);
      }
      assertNoSensitiveKeys(v, `${path}.${k}`);
    }
  }
}

/** Pure preparation step: size cap, hash, header allow-list, credential guard. */
export function prepareRawPayload(input: RawPayloadInput): PreparedRawPayload {
  const bodyBytes = Buffer.from(input.body.buffer, input.body.byteOffset, input.body.byteLength);
  if (bodyBytes.byteLength > MAX_RAW_PAYLOAD_BYTES) {
    throw new PayloadTooLargeError(
      `Payload is ${bodyBytes.byteLength} bytes; limit is ${MAX_RAW_PAYLOAD_BYTES}.`,
    );
  }
  const requestParams = input.requestParams ?? {};
  assertNoSensitiveKeys(requestParams);

  const responseHeaders: Record<string, string> = {};
  const droppedHeaderNames: string[] = [];
  for (const [name, value] of Object.entries(input.responseHeaders ?? {})) {
    const lower = name.toLowerCase();
    if (ALLOWED_RESPONSE_HEADERS.has(lower)) responseHeaders[lower] = value;
    else droppedHeaderNames.push(lower);
  }

  let bodyJson: unknown;
  try {
    bodyJson = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bodyBytes));
  } catch {
    bodyJson = null; // not valid UTF-8 JSON: bytes are still stored exactly
  }

  return {
    bodyBytes,
    sha256: createHash('sha256').update(bodyBytes).digest(),
    byteSize: bodyBytes.byteLength,
    bodyJson,
    responseHeaders,
    droppedHeaderNames,
    requestParams,
  };
}

export interface StoredRawPayload {
  readonly id: number;
  readonly sha256Hex: string;
  /** True when an identical response for the identical request was already stored. */
  readonly deduplicated: boolean;
}

/**
 * Store a raw response in its own transaction ("raw first"): it survives even
 * if parsing or import later fails. Identical (source, endpoint, request,
 * bytes) is stored once.
 */
export async function storeRawPayload(
  pool: pg.Pool,
  actor: string,
  input: RawPayloadInput,
): Promise<StoredRawPayload> {
  const p = prepareRawPayload(input);
  return withTransaction(pool, { actor }, async ({ db }) => {
    const [src] = await db
      .select({ id: source.id })
      .from(source)
      .where(eq(source.code, input.sourceCode));
    if (!src) throw new Error(`Unknown source ${input.sourceCode}`);
    const inserted = await db
      .insert(rawPayload)
      .values({
        sourceId: src.id,
        importRunId: input.importRunId ?? null,
        endpoint: input.endpoint,
        requestMethod: input.requestMethod,
        requestParams: p.requestParams,
        httpStatus: input.httpStatus,
        fetchedAt: input.fetchedAt,
        contentType: input.contentType ?? null,
        responseHeaders: p.responseHeaders,
        bodyBytes: p.bodyBytes,
        byteSize: p.byteSize,
        sha256: p.sha256,
        bodyJson: p.bodyJson,
        provenance: input.provenance,
      })
      .onConflictDoNothing()
      .returning({ id: rawPayload.id });
    if (inserted[0])
      return { id: inserted[0].id, sha256Hex: p.sha256.toString('hex'), deduplicated: false };

    const [existing] = await db
      .select({ id: rawPayload.id })
      .from(rawPayload)
      .where(
        and(
          eq(rawPayload.sourceId, src.id),
          eq(rawPayload.endpoint, input.endpoint),
          sql`${rawPayload.requestParams} = ${JSON.stringify(p.requestParams)}::jsonb`,
          eq(rawPayload.sha256, p.sha256),
        ),
      );
    if (!existing) throw new Error('raw_payload conflict but no existing row found');
    return { id: existing.id, sha256Hex: p.sha256.toString('hex'), deduplicated: true };
  });
}

/** Re-verify stored bytes against the stored SHA-256 (defence in depth on top of the CHECK). */
export async function verifyRawPayloadIntegrity(pool: pg.Pool, id: number): Promise<boolean> {
  const { rows } = await pool.query<{ body_bytes: Buffer; sha256: Buffer; byte_size: number }>(
    'SELECT body_bytes, sha256, byte_size FROM raw_payload WHERE id = $1',
    [id],
  );
  const row = rows[0];
  if (!row) return false;
  return (
    row.body_bytes.byteLength === row.byte_size &&
    createHash('sha256').update(row.body_bytes).digest().equals(row.sha256)
  );
}
