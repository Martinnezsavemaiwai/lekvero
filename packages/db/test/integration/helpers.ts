import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { expect, inject } from 'vitest';
import {
  GloByDateEnvelopeSchema,
  GloLatestEnvelopeSchema,
  mapGloDraw,
  validateDrawResult,
} from '@lekvero/shared';
import type { DrawResult } from '@lekvero/shared';
import { createPool, dbFor } from '../../src/client';
import type { Db } from '../../src/client';
import { recordImport } from '../../src/imports';
import type { RecordImportOutcome } from '../../src/imports';
import { recordOfficialEvidence, recordOperatorReview, verifyResultSet } from '../../src/lifecycle';
import { storeRawPayload } from '../../src/raw-payload';
import { sqlState } from '../../src/tx';
import { urlFor } from './urls';

export const FIXTURE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../fixtures/glo/v1',
);

export interface TestDb {
  readonly name: string;
  readonly owner: pg.Pool;
  readonly writer: pg.Pool;
  readonly reader: pg.Pool;
  readonly writerUrl: string;
  readonly readerDb: Db;
  readonly writerDb: Db;
  close(): Promise<void>;
}

/** A brand-new database cloned from the migrated template; one per test file. */
export async function freshDatabase(label: string): Promise<TestDb> {
  const ctx = inject('lekvero');
  const name = `lekvero_it_${ctx.suffix}_${label}_${randomBytes(3).toString('hex')}`.slice(0, 63);
  const admin = new pg.Client({ connectionString: ctx.adminUrl });
  await admin.connect();
  try {
    await admin.query(
      `CREATE DATABASE ${name} TEMPLATE ${ctx.template} OWNER ${ctx.roles.owner.name}`,
    );
    await admin.query(`REVOKE ALL ON DATABASE ${name} FROM PUBLIC`);
    await admin.query(`GRANT CONNECT ON DATABASE ${name} TO lekvero_reader, lekvero_writer`);
  } finally {
    await admin.end();
  }
  const writerUrl = urlFor(ctx.adminUrl, ctx.roles.writer, name);
  const owner = createPool(urlFor(ctx.adminUrl, ctx.roles.owner, name), 'it-owner');
  const writer = createPool(writerUrl, 'it-writer');
  const reader = createPool(urlFor(ctx.adminUrl, ctx.roles.reader, name), 'it-reader');
  return {
    name,
    owner,
    writer,
    reader,
    writerUrl,
    readerDb: dbFor(reader),
    writerDb: dbFor(writer),
    async close() {
      await Promise.all([owner.end(), writer.end(), reader.end()]);
    },
  };
}

/** Assert a promise rejects with the given SQLSTATE (and optional message fragment). */
export async function expectPgError(
  p: Promise<unknown>,
  code: string,
  message?: RegExp,
): Promise<void> {
  let err: unknown;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  expect(err, 'expected a database error').toBeDefined();
  expect(sqlState(err), String((err as { cause?: unknown })?.cause ?? err)).toBe(code);
  if (message) {
    const msg = `${(err as Error).message} ${(err as { cause?: Error }).cause?.message ?? ''}`;
    expect(msg).toMatch(message);
  }
}

export const PERMISSION_DENIED = '42501';
export const RESTRICT_VIOLATION = '23001';
export const CHECK_VIOLATION = '23514';

export function fixtureBytes(rel: string): Buffer {
  return readFileSync(join(FIXTURE_ROOT, rel));
}

/** Parsed + mapped canonical draw from an archived fixture. */
export function fixtureDraw(date: string): { bytes: Buffer; draw: DrawResult } {
  const rel =
    date === '2026-11-16' ? 'live/latest/2026-11-16.json' : `live/result-by-date/${date}.json`;
  const bytes = fixtureBytes(rel);
  const json: unknown = JSON.parse(bytes.toString('utf8'));
  const raw =
    date === '2026-11-16'
      ? GloLatestEnvelopeSchema.parse(json).response
      : GloByDateEnvelopeSchema.parse(json).response!.result;
  return { bytes, draw: mapGloDraw(raw) };
}

/**
 * SYNTHETIC variant of a draw for correction tests: replaces one fifth-prize
 * number. Not GLO data.
 */
export function variant(draw: DrawResult, replacement: string): DrawResult {
  return {
    ...draw,
    prizes: draw.prizes.map((p) =>
      p.category === 'fifth' ? { ...p, numbers: [replacement, ...p.numbers.slice(1)] } : p,
    ),
  };
}

let rawCounter = 0;
/** Store a raw payload for a (possibly synthetic) draw and import it as the writer. */
export async function importDraw(
  t: TestDb,
  draw: DrawResult,
  opts: { body?: Buffer; actor?: string } = {},
): Promise<RecordImportOutcome> {
  const body = opts.body ?? Buffer.from(JSON.stringify({ synthetic: true, n: rawCounter++, draw }));
  const raw = await storeRawPayload(t.writer, 'it', {
    sourceCode: 'glo_api',
    endpoint: 'https://www.glo.or.th/api/checking/getLotteryResult',
    requestMethod: 'POST',
    requestParams: { date: draw.drawDate },
    httpStatus: 200,
    fetchedAt: new Date('2026-11-16T16:30:00Z'),
    body,
    provenance: opts.body ? 'integration-test (fixture bytes)' : 'integration-test (synthetic)',
  });
  return recordImport(t.writer, opts.actor ?? 'it', {
    rawPayloadId: raw.id,
    result: draw,
    validation: validateDrawResult(draw),
  });
}

/** Attach passing official evidence (+ operator review if needed) and verify. */
export async function verifyWithEvidence(t: TestDb, resultSetId: number, withReview = false) {
  await recordOfficialEvidence(t.writer, 'it', resultSetId, {
    code: 'test_official_evidence',
    outcome: 'PASS',
    evidenceRef: 'test://official-evidence',
    performedBy: 'it:operator',
  });
  if (withReview) {
    await recordOperatorReview(t.writer, 'it', resultSetId, {
      outcome: 'PASS',
      performedBy: 'it:operator',
      notes: 'reviewed in test',
    });
  }
  return verifyResultSet(t.writer, 'it', resultSetId, 'it:operator');
}
