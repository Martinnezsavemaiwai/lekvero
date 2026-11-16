import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkTicket } from '@lekvero/shared';
import { EnvironmentNotAllowedError } from '../../src/errors';
import { seedFixtures } from '../../src/fixtures';
import { getCurrentResult, listVersions } from '../../src/reads';
import { FIXTURE_ROOT, fixtureDraw, freshDatabase } from './helpers';
import type { TestDb } from './helpers';

let t: TestDb;
beforeAll(async () => {
  t = await freshDatabase('fix');
});
afterAll(() => t.close());

const DATES = [
  '2011-02-01',
  '2013-02-01',
  '2015-01-16',
  '2020-01-17',
  '2024-03-01',
  '2024-12-16',
  '2025-01-17',
  '2026-11-16',
];

describe('fixture seeding (local/test only)', () => {
  it('refuses outside local/test environments and non-loopback hosts', async () => {
    await expect(
      seedFixtures(t.writer, {
        fixtureRoot: FIXTURE_ROOT,
        connectionString: t.writerUrl,
        env: { LEKVERO_ENV: 'production' },
      }),
    ).rejects.toThrow(EnvironmentNotAllowedError);
    await expect(
      seedFixtures(t.writer, {
        fixtureRoot: FIXTURE_ROOT,
        connectionString: 'postgres://u:p@db.example.com/x',
        env: { LEKVERO_ENV: 'local' },
      }),
    ).rejects.toThrow(EnvironmentNotAllowedError);
  });

  it('loads all 8 archived draws; only the one with official checker evidence is VERIFIED', async () => {
    const report = await seedFixtures(t.writer, {
      fixtureRoot: FIXTURE_ROOT,
      connectionString: t.writerUrl,
      env: { LEKVERO_ENV: 'test' },
    });
    expect(report.draws.map((d) => d.drawDate).sort()).toEqual(DATES);
    expect(report.draws.every((d) => d.outcome === 'created' && d.status === 'VALIDATED')).toBe(
      true,
    );
    expect(report.verified).toEqual(['2024-03-01']);
    for (const date of DATES) {
      const current = await getCurrentResult(t.readerDb, date);
      if (date === '2024-03-01') expect(current?.verificationStatus).toBe('VERIFIED');
      else expect(current).toBeNull();
    }
  });

  it('round-trips: DB results equal the mapped fixtures, incl. null legacy amounts', async () => {
    for (const date of DATES) {
      const [v] = await listVersions(t.readerDb, date);
      const stored = await t.readerDb.query.resultSet.findFirst({
        where: (rs, { eq }) => eq(rs.id, v!.resultSetId),
      });
      expect(stored).toBeTruthy();
    }
    const current = await getCurrentResult(t.readerDb, '2024-03-01');
    const { draw } = fixtureDraw('2024-03-01');
    expect(current!.result).toEqual(draw);
    for (const ticket of ['253603', '000079', '253602', '123456']) {
      expect(checkTicket(current!.result, ticket)).toEqual(checkTicket(draw, ticket));
    }
    const legacy = await t.reader.query(
      `SELECT count(*) FILTER (WHERE rp.amount_baht IS NOT NULL)::int AS with_amount
         FROM result_prize rp JOIN result_set rs ON rs.id = rp.result_set_id
         JOIN prize_structure s ON s.id = rs.prize_structure_id WHERE s.code = 'LEGACY_LAST3X4'`,
    );
    expect(legacy.rows[0].with_amount).toBe(0);
  });

  it('re-seeding is idempotent (raw payloads deduplicated, versions unchanged)', async () => {
    const before = await t.writer.query(
      'SELECT (SELECT count(*) FROM raw_payload)::int AS r, (SELECT count(*) FROM result_set)::int AS s',
    );
    const report = await seedFixtures(t.writer, {
      fixtureRoot: FIXTURE_ROOT,
      connectionString: t.writerUrl,
      env: { LEKVERO_ENV: 'test' },
    });
    expect(report.draws.every((d) => d.outcome === 'unchanged')).toBe(true);
    const after = await t.writer.query(
      'SELECT (SELECT count(*) FROM raw_payload)::int AS r, (SELECT count(*) FROM result_set)::int AS s',
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it('records official evidence with a reference to the archived artefacts', async () => {
    const { rows } = await t.reader.query(
      `SELECT vc.check_code, vc.outcome, vc.evidence_ref FROM verification_check vc
         JOIN result_set rs ON rs.id = vc.result_set_id JOIN draw d ON d.id = rs.draw_id
        WHERE d.draw_date = '2024-03-01' AND vc.check_kind = 'OFFICIAL_EVIDENCE'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      check_code: 'archived_glo_checker_crosscheck',
      outcome: 'PASS',
    });
    expect(rows[0].evidence_ref).toMatch(
      /live\/check\/2024-03-01_winners\.json#sha256=[0-9a-f]{64}/,
    );
  });
});
