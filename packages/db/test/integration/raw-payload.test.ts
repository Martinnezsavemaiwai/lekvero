import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PayloadTooLargeError, SensitiveDataError } from '../../src/errors';
import { storeRawPayload, verifyRawPayloadIntegrity } from '../../src/raw-payload';
import type { RawPayloadInput } from '../../src/raw-payload';
import { MAX_RAW_PAYLOAD_BYTES } from '../../src/schema';
import { CHECK_VIOLATION, expectPgError, fixtureBytes, freshDatabase } from './helpers';
import type { TestDb } from './helpers';

let t: TestDb;
beforeAll(async () => {
  t = await freshDatabase('raw');
});
afterAll(() => t.close());

const base = (body: Buffer, extra: Partial<RawPayloadInput> = {}): RawPayloadInput => ({
  sourceCode: 'glo_api',
  endpoint: 'https://www.glo.or.th/api/lottery/getLatestLottery',
  requestMethod: 'POST',
  requestParams: {},
  httpStatus: 200,
  fetchedAt: new Date('2026-11-16T16:32:05Z'),
  body,
  provenance: 'integration-test',
  ...extra,
});

describe('raw payload storage', () => {
  const bytes = fixtureBytes('live/latest/2026-11-16.json');

  it('preserves exact bytes and a verifiable SHA-256', async () => {
    const stored = await storeRawPayload(t.writer, 'it', base(bytes));
    expect(stored.sha256Hex).toBe(createHash('sha256').update(bytes).digest('hex'));
    const { rows } = await t.writer.query(
      'SELECT body_bytes, byte_size, body_json IS NOT NULL AS parsed FROM raw_payload WHERE id = $1',
      [stored.id],
    );
    expect(Buffer.compare(rows[0].body_bytes, bytes)).toBe(0);
    expect(rows[0].byte_size).toBe(bytes.byteLength);
    expect(rows[0].parsed).toBe(true);
    expect(await verifyRawPayloadIntegrity(t.writer, stored.id)).toBe(true);
  });

  it('keeps non-JSON bodies byte-exact (body_json NULL)', async () => {
    const odd = Buffer.from([0xff, 0xfe, 0x00, 0x7b]);
    const stored = await storeRawPayload(t.writer, 'it', base(odd, { endpoint: 'binary-test' }));
    const { rows } = await t.writer.query(
      'SELECT body_bytes, body_json FROM raw_payload WHERE id = $1',
      [stored.id],
    );
    expect(Buffer.compare(rows[0].body_bytes, odd)).toBe(0);
    expect(rows[0].body_json).toBeNull();
  });

  it('deduplicates identical request + response, but not different requests', async () => {
    const a = await storeRawPayload(t.writer, 'it', base(bytes));
    const b = await storeRawPayload(t.writer, 'it', base(bytes));
    expect(b).toEqual({ ...a, deduplicated: true });
    const c = await storeRawPayload(t.writer, 'it', base(bytes, { requestParams: { date: '16' } }));
    expect(c.id).not.toBe(a.id);
  });

  it('never stores cookies or auth headers (allow-list)', async () => {
    const stored = await storeRawPayload(
      t.writer,
      'it',
      base(Buffer.from('{"h":1}'), {
        endpoint: 'headers-test',
        responseHeaders: {
          'Set-Cookie': 'TS01=secret; Path=/',
          Cookie: 'a=b',
          Authorization: 'Bearer x',
          'X-Api-Key': 'k',
          'Cache-Control': 'max-age=1800',
          Date: 'Mon, 16 Nov 2026 16:27:14 GMT',
        },
      }),
    );
    const { rows } = await t.writer.query(
      'SELECT response_headers FROM raw_payload WHERE id = $1',
      [stored.id],
    );
    expect(rows[0].response_headers).toEqual({
      'cache-control': 'max-age=1800',
      date: 'Mon, 16 Nov 2026 16:27:14 GMT',
    });
  });

  it('refuses credential-like request parameters', async () => {
    await expect(
      storeRawPayload(
        t.writer,
        'it',
        base(Buffer.from('{}'), { requestParams: { nested: { apiKey: 'x' } } }),
      ),
    ).rejects.toThrow(SensitiveDataError);
  });

  it('enforces the size limit in the application', async () => {
    await expect(
      storeRawPayload(t.writer, 'it', base(Buffer.alloc(MAX_RAW_PAYLOAD_BYTES + 1, 0x20))),
    ).rejects.toThrow(PayloadTooLargeError);
  });

  describe('database constraints (bypassing the application)', () => {
    const insert = (body: Buffer, sha: Buffer, size: number, headers = '{}') =>
      t.writer.query(
        `INSERT INTO raw_payload (source_id, endpoint, request_method, http_status, fetched_at,
           body_bytes, byte_size, sha256, response_headers, provenance)
         VALUES (1, 'direct', 'POST', 200, now(), $1, $2, $3, $4::jsonb, 'direct-sql')`,
        [body, size, sha, headers],
      );
    const sha = (b: Buffer) => createHash('sha256').update(b).digest();

    it('rejects a wrong SHA-256', async () => {
      const b = Buffer.from('abc');
      await expectPgError(
        insert(b, sha(Buffer.from('abd')), 3),
        CHECK_VIOLATION,
        /raw_payload_sha256/,
      );
    });
    it('rejects a wrong byte_size', async () => {
      const b = Buffer.from('abc');
      await expectPgError(insert(b, sha(b), 4), CHECK_VIOLATION, /raw_payload_size/);
    });
    it('rejects oversize bodies', async () => {
      const b = Buffer.alloc(MAX_RAW_PAYLOAD_BYTES + 1, 0x20);
      await expectPgError(insert(b, sha(b), b.byteLength), CHECK_VIOLATION, /raw_payload_size/);
    });
    it('rejects secret headers', async () => {
      const b = Buffer.from('h');
      await expectPgError(
        insert(b, sha(b), 1, '{"set-cookie":"x"}'),
        CHECK_VIOLATION,
        /raw_payload_no_secret_headers/,
      );
    });
  });
});
