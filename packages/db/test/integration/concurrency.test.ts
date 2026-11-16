import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateDrawResult } from '@lekvero/shared';
import { recordImport } from '../../src/imports';
import { approveCorrection } from '../../src/lifecycle';
import { getCurrentResult, listVersions } from '../../src/reads';
import { withTransaction } from '../../src/tx';
import { fixtureDraw, freshDatabase, importDraw, variant, verifyWithEvidence } from './helpers';
import type { TestDb } from './helpers';

let t: TestDb;
beforeAll(async () => {
  t = await freshDatabase('conc');
});
afterAll(() => t.close());

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('concurrent imports of the same draw', () => {
  it('identical concurrent imports create exactly one version', async () => {
    const { draw, bytes } = fixtureDraw('2024-03-01');
    const results = await Promise.all(
      Array.from({ length: 8 }, () => importDraw(t, draw, { body: bytes })),
    );
    expect(results.filter((r) => r.outcome === 'created')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'unchanged')).toHaveLength(7);
    expect(new Set(results.map((r) => r.resultSetId)).size).toBe(1);
    const versions = await listVersions(t.readerDb, '2024-03-01');
    expect(versions.map((v) => [v.version, v.status])).toEqual([[1, 'VALIDATED']]);
  });

  it('different concurrent imports get contiguous versions; only the first is VALIDATED', async () => {
    const { draw } = fixtureDraw('2024-12-16');
    const variants = ['000001', '000002', '000003', '000004', '000005', '000006'].map((n) =>
      variant(draw, n),
    );
    const results = await Promise.all(variants.map((v) => importDraw(t, v)));
    expect(results.every((r) => r.outcome === 'created')).toBe(true);
    const versions = await listVersions(t.readerDb, '2024-12-16');
    expect(versions.map((v) => v.version)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(versions[0]!.status).toBe('VALIDATED');
    expect(
      versions
        .slice(1)
        .every(
          (v) =>
            v.status === 'QUARANTINED' && /conflicts_with_existing_versions/.test(v.reason ?? ''),
        ),
    ).toBe(true);
  });

  it('imports wait for a held draw lock and are then serialised', async () => {
    const { draw } = fixtureDraw('2020-01-17');
    await importDraw(t, draw); // creates the draw row (v1)
    const client = await t.writer.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT id FROM draw WHERE draw_date = '2020-01-17' FOR UPDATE");
      let settled = 0;
      // Guaranteed overlap: two IDENTICAL imports and one DIFFERENT import all queue on the lock.
      const x = variant(draw, '000011');
      const pending = [x, x, variant(draw, '000012')].map((v) =>
        importDraw(t, v).finally(() => settled++),
      );
      await sleep(500);
      expect(settled).toBe(0); // all blocked on the lock
      await client.query('COMMIT');
      const rs = await Promise.all(pending);
      expect(
        rs
          .filter((r) => r.outcome === 'created')
          .map((r) => r.version)
          .sort(),
      ).toEqual([2, 3]);
      expect(rs.filter((r) => r.outcome === 'unchanged')).toHaveLength(1);
      expect((await listVersions(t.readerDb, '2020-01-17')).map((v) => v.version)).toEqual([
        1, 2, 3,
      ]);
    } finally {
      client.release();
    }
  });
});

describe('re-delivery of older content', () => {
  it('X, Y, X: re-delivered X matches its non-superseded version (no duplicate)', async () => {
    // Deterministic reproduction of the X,Y,X lock order seen under load.
    const { draw } = fixtureDraw('2024-03-01');
    const x = variant(draw, '000021');
    const y = variant(draw, '000022');
    const rx = await importDraw(t, x);
    const ry = await importDraw(t, y);
    expect(ry.outcome).toBe('created');
    const again = await importDraw(t, x);
    expect(again).toMatchObject({ outcome: 'unchanged', resultSetId: rx.resultSetId });
  });
});

describe('A → B → A corrections', () => {
  it('a reverted correction becomes a new version and can be made current again', async () => {
    const { draw: A, bytes } = fixtureDraw('2015-01-16');
    const B = variant(A, '000777');

    const v1 = await importDraw(t, A, { body: bytes });
    await verifyWithEvidence(t, v1.resultSetId);

    const v2 = await importDraw(t, B);
    expect(v2).toMatchObject({ outcome: 'created', version: 2, status: 'QUARANTINED' });
    await verifyWithEvidence(t, v2.resultSetId, true);
    await approveCorrection(t.writer, 'it', {
      toResultSetId: v2.resultSetId,
      reason: 'A→B',
      detectedBy: 'reconcile',
      approvedBy: 'it',
    });

    // Re-importing B is unchanged; A differs from current B → new v3 (allowed: no UNIQUE(content_hash), D5).
    expect((await importDraw(t, B)).outcome).toBe('unchanged');
    const v3 = await importDraw(t, A, { body: bytes });
    expect(v3).toMatchObject({ outcome: 'created', version: 3, status: 'QUARANTINED' });
    await verifyWithEvidence(t, v3.resultSetId, true);
    await approveCorrection(t.writer, 'it', {
      toResultSetId: v3.resultSetId,
      reason: 'B→A (reverted)',
      detectedBy: 'reconcile',
      approvedBy: 'it',
    });

    const current = await getCurrentResult(t.readerDb, '2015-01-16');
    expect(current).toMatchObject({ version: 3, result: A });
    const corrections = await t.reader.query(
      `SELECT c.reason FROM correction c JOIN draw d ON d.id = c.draw_id WHERE d.draw_date = '2015-01-16' ORDER BY c.id`,
    );
    expect(corrections.rows.map((r) => r.reason)).toEqual(['A→B', 'B→A (reverted)']);
  });
});

describe('failed transactions and retries', () => {
  it('a failed import rolls back completely (no draw, no version) and a retry allocates v1', async () => {
    const { draw, bytes } = fixtureDraw('2011-02-01');
    await expect(
      recordImport(t.writer, 'it', {
        rawPayloadId: 999_999_999,
        result: draw,
        validation: validateDrawResult(draw),
      }),
    ).rejects.toThrow();
    const { rowCount } = await t.writer.query("SELECT 1 FROM draw WHERE draw_date = '2011-02-01'");
    expect(rowCount).toBe(0);

    const retry = await importDraw(t, draw, { body: bytes });
    expect(retry).toMatchObject({ outcome: 'created', version: 1 });
  });

  it('withTransaction retries serialization failures and keeps only the successful attempt', async () => {
    const marker = `retry-${Date.now()}`;
    let attempts = 0;
    await withTransaction(t.writer, { actor: 'it' }, async ({ client }) => {
      attempts++;
      await client.query(
        "INSERT INTO import_run (source_id, trigger, stats) VALUES (1, 'manual', jsonb_build_object('marker', $1::text, 'attempt', $2::int))",
        [marker, attempts],
      );
      if (attempts === 1) throw Object.assign(new Error('simulated'), { code: '40001' });
    });
    expect(attempts).toBe(2);
    const { rows } = await t.writer.query(
      "SELECT stats->>'attempt' AS a FROM import_run WHERE stats->>'marker' = $1",
      [marker],
    );
    expect(rows).toEqual([{ a: '2' }]);
  });

  it('non-retryable errors are not retried', async () => {
    let attempts = 0;
    await expect(
      withTransaction(t.writer, { actor: 'it' }, async () => {
        attempts++;
        throw Object.assign(new Error('boom'), { code: '23505' });
      }),
    ).rejects.toThrow('boom');
    expect(attempts).toBe(1);
  });
});
