import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PRIZE_CATEGORIES, PRIZE_STRUCTURES } from '@lekvero/shared';
import { runMigrations } from '../../src/migrate';
import { urlFor } from './urls';
import { freshDatabase } from './helpers';
import type { TestDb } from './helpers';
import { inject } from 'vitest';

let t: TestDb;
beforeAll(async () => {
  t = await freshDatabase('mig');
});
afterAll(() => t.close());

describe('migrations', () => {
  it('applied all migrations exactly once', async () => {
    const { rows } = await t.owner.query(
      'SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations',
    );
    expect(rows[0].n).toBe(4);
  });

  it('re-running migrations is a no-op', async () => {
    const ctx = inject('lekvero');
    await runMigrations(urlFor(ctx.adminUrl, ctx.roles.owner, t.name));
    const { rows } = await t.owner.query(
      'SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations',
    );
    expect(rows[0].n).toBe(4);
  });

  it('objects are owned by the migration owner', async () => {
    const { rows } = await t.owner.query(
      "SELECT DISTINCT tableowner FROM pg_tables WHERE schemaname = 'public'",
    );
    expect(rows).toEqual([{ tableowner: inject('lekvero').roles.owner.name }]);
  });

  it('installs every custom trigger and the same-draw pointer FK', async () => {
    const { rows } = await t.owner.query<{ tgname: string }>(
      'SELECT tgname FROM pg_trigger WHERE NOT tgisinternal ORDER BY tgname',
    );
    const names = rows.map((r) => r.tgname);
    for (const expected of [
      'result_set_guard',
      'draw_guard',
      'correction_guard',
      'import_run_guard',
      'result_prize_content_guard',
      'prize_number_content_guard',
      'verification_check_guard',
      'raw_payload_append_only',
      'prize_number_append_only',
      'audit_log_append_only',
      'result_set_no_delete',
      'draw_no_delete',
      'result_set_no_truncate',
      'result_set_audit',
      'draw_audit',
      'correction_audit',
      'raw_payload_audit',
    ]) {
      expect(names).toContain(expected);
    }
    const fk = await t.owner.query(
      "SELECT 1 FROM pg_constraint WHERE conname = 'draw_current_result_set_fk' AND contype = 'f'",
    );
    expect(fk.rowCount).toBe(1);
  });

  it('reference data equals the @lekvero/shared constants', async () => {
    const cats = await t.reader.query(
      'SELECT code, name_th, name_en, match_type, digits, sort_order FROM prize_category ORDER BY sort_order',
    );
    expect(cats.rows).toEqual(
      Object.values(PRIZE_CATEGORIES)
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((c) => ({
          code: c.code,
          name_th: c.nameTh,
          name_en: c.nameEn,
          match_type: c.matchType,
          digits: c.digits,
          sort_order: c.sortOrder,
        })),
    );
    const rules = await t.reader.query<{ s: string; c: string; n: number }>(
      `SELECT s.code AS s, c.code AS c, r.expected_count AS n
         FROM prize_structure_rule r JOIN prize_structure s ON s.id = r.prize_structure_id
         JOIN prize_category c ON c.id = r.prize_category_id`,
    );
    const fromDb: Record<string, Record<string, number>> = {};
    for (const r of rules.rows) (fromDb[r.s] ??= {})[r.c] = r.n;
    const fromShared = Object.fromEntries(
      Object.values(PRIZE_STRUCTURES).map((s) => [s.code, { ...s.expectedCounts }]),
    );
    expect(fromDb).toEqual(fromShared);
  });

  it('stores no prize amounts in reference data (D2)', async () => {
    const { rows } = await t.owner.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'prize_structure_rule'",
    );
    expect(rows.map((r) => r.column_name).sort()).toEqual([
      'expected_count',
      'prize_category_id',
      'prize_structure_id',
    ]);
  });
});
