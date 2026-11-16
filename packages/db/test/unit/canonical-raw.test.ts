import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GloByDateEnvelopeSchema, mapGloDraw } from '@lekvero/shared';
import type { DrawResult } from '@lekvero/shared';
import { canonicalEncoding, contentHash } from '../../src/canonical';
import { assertFixtureSeedingAllowed } from '../../src/env-guard';
import {
  EnvironmentNotAllowedError,
  PayloadTooLargeError,
  SensitiveDataError,
} from '../../src/errors';
import { prepareRawPayload } from '../../src/raw-payload';
import type { RawPayloadInput } from '../../src/raw-payload';
import { MAX_RAW_PAYLOAD_BYTES } from '../../src/schema';
import { sqlState } from '../../src/tx';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../fixtures/glo/v1');
const draw = mapGloDraw(
  GloByDateEnvelopeSchema.parse(
    JSON.parse(readFileSync(`${root}/live/result-by-date/2024-03-01.json`, 'utf8')),
  ).response!.result,
);

describe('content hash', () => {
  it('is stable (golden) for the archived 2024-03-01 draw', () => {
    // Changing this value means the canonical encoding changed: bump its version `v`.
    expect(contentHash(draw).toString('hex')).toMatchInlineSnapshot(
      `"52f5dde423396d15b3fa5379d969b6a27330eed3cd72690ceddff0bffa04ecb6"`,
    );
  });
  it('ignores the order of categories and numbers (draw order is not content)', () => {
    const shuffled: DrawResult = {
      ...draw,
      prizes: [...draw.prizes].reverse().map((p) => ({ ...p, numbers: [...p.numbers].reverse() })),
    };
    expect(contentHash(shuffled).equals(contentHash(draw))).toBe(true);
  });
  it('changes when a number, an amount, the date or the structure changes', () => {
    const h = contentHash(draw);
    const edit = (f: (d: DrawResult) => DrawResult) => contentHash(f(structuredClone(draw)));
    expect(edit((d) => ({ ...d, drawDate: '2024-03-02' })).equals(h)).toBe(false);
    expect(edit((d) => ({ ...d, prizeStructure: 'LEGACY_LAST3X4' })).equals(h)).toBe(false);
    expect(
      edit((d) => {
        d.prizes[0]!.numbers[0] = '000000';
        return d;
      }).equals(h),
    ).toBe(false);
    expect(
      edit((d) => {
        d.prizes[0]!.amountBaht = null;
        return d;
      }).equals(h),
    ).toBe(false);
  });
  it('encoding is versioned', () => {
    expect(JSON.parse(canonicalEncoding(draw)).v).toBe(1);
  });
});

describe('prepareRawPayload', () => {
  const input = (over: Partial<RawPayloadInput> = {}): RawPayloadInput => ({
    sourceCode: 'glo_api',
    endpoint: 'e',
    requestMethod: 'POST',
    requestParams: {},
    httpStatus: 200,
    fetchedAt: new Date(0),
    body: Buffer.from('{"a":1}'),
    provenance: 'unit',
    ...over,
  });
  it('allow-lists headers case-insensitively and reports dropped names only', () => {
    const p = prepareRawPayload(
      input({ responseHeaders: { 'Set-Cookie': 's', ETag: 'x', 'X-Weird': 'y' } }),
    );
    expect(p.responseHeaders).toEqual({ etag: 'x' });
    expect(p.droppedHeaderNames.sort()).toEqual(['set-cookie', 'x-weird']);
  });
  it.each(['password', 'apiKey', 'api_key', 'token', 'Authorization', 'sessionId', 'cookie'])(
    'rejects param key %s',
    (k) => {
      expect(() => prepareRawPayload(input({ requestParams: { deep: [{ [k]: 'x' }] } }))).toThrow(
        SensitiveDataError,
      );
    },
  );
  it('accepts the real GLO request shapes', () => {
    expect(() =>
      prepareRawPayload(
        input({
          requestParams: { number: [{ lottery_num: '123456' }], period_date: '2024-03-01' },
        }),
      ),
    ).not.toThrow();
  });
  it('enforces the size limit exactly', () => {
    expect(prepareRawPayload(input({ body: Buffer.alloc(MAX_RAW_PAYLOAD_BYTES) })).byteSize).toBe(
      MAX_RAW_PAYLOAD_BYTES,
    );
    expect(() =>
      prepareRawPayload(input({ body: Buffer.alloc(MAX_RAW_PAYLOAD_BYTES + 1) })),
    ).toThrow(PayloadTooLargeError);
  });
  it('parses JSON when possible, never alters bytes', () => {
    const p = prepareRawPayload(input({ body: Buffer.from('{"a": 1}') }));
    expect(p.bodyJson).toEqual({ a: 1 });
    expect(p.bodyBytes.toString()).toBe('{"a": 1}');
    expect(prepareRawPayload(input({ body: Buffer.from('not json') })).bodyJson).toBeNull();
  });
});

describe('assertFixtureSeedingAllowed', () => {
  const ok = 'postgres://u:p@127.0.0.1:5432/db';
  it.each([undefined, '', 'production', 'staging'])('rejects LEKVERO_ENV=%j', (env) => {
    expect(() => assertFixtureSeedingAllowed({ LEKVERO_ENV: env }, ok)).toThrow(
      EnvironmentNotAllowedError,
    );
  });
  it.each(['postgres://u:p@db.internal/x', 'postgres://u:p@10.0.0.5/x'])(
    'rejects non-loopback %s',
    (url) => {
      expect(() => assertFixtureSeedingAllowed({ LEKVERO_ENV: 'local' }, url)).toThrow(
        EnvironmentNotAllowedError,
      );
    },
  );
  it.each(['local', 'test'])('allows %s on loopback', (env) => {
    expect(() => assertFixtureSeedingAllowed({ LEKVERO_ENV: env }, ok)).not.toThrow();
    expect(() =>
      assertFixtureSeedingAllowed({ LEKVERO_ENV: env }, 'postgres://u:p@localhost/x'),
    ).not.toThrow();
  });
});

describe('sqlState', () => {
  it('reads plain and Drizzle-wrapped pg errors', () => {
    expect(sqlState({ code: '40001' })).toBe('40001');
    expect(sqlState({ cause: { code: '40P01' } })).toBe('40P01');
    expect(sqlState(new Error('x'))).toBeUndefined();
  });
});
