import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkTicket } from '@lekvero/shared';
import type { DrawResult } from '@lekvero/shared';
import { UnstorableResultError } from '../../src/errors';
import {
  approveCorrection,
  quarantineResultSet,
  recordOfficialEvidence,
  recordOperatorReview,
  rejectResultSet,
  verifyResultSet,
} from '../../src/lifecycle';
import { getCurrentResult, getResultSet, listVersions } from '../../src/reads';
import {
  CHECK_VIOLATION,
  RESTRICT_VIOLATION,
  expectPgError,
  fixtureDraw,
  freshDatabase,
  importDraw,
  variant,
  verifyWithEvidence,
} from './helpers';
import type { TestDb } from './helpers';

let t: TestDb;
beforeAll(async () => {
  t = await freshDatabase('life');
});
afterAll(() => t.close());

const created = (r: Awaited<ReturnType<typeof importDraw>>) => {
  if (r.outcome !== 'created') throw new Error(`expected created, got ${r.outcome}`);
  return r;
};

describe('schema validity is NOT verification', () => {
  it('a valid first import is VALIDATED, not VERIFIED, and not published', async () => {
    const { draw, bytes } = fixtureDraw('2024-12-16');
    const r = created(await importDraw(t, draw, { body: bytes }));
    expect(r).toMatchObject({ version: 1, status: 'VALIDATED', reason: null });
    expect(await getCurrentResult(t.readerDb, '2024-12-16')).toBeNull();
  });

  it('cannot become VERIFIED without official evidence', async () => {
    const [v] = await listVersions(t.readerDb, '2024-12-16');
    await expectPgError(
      verifyResultSet(t.writer, 'it', v!.resultSetId, 'it'),
      CHECK_VIOLATION,
      /needs OFFICIAL_EVIDENCE PASS/,
    );
  });

  it('WARN evidence is not enough; a later PASS does not erase it', async () => {
    const [v] = await listVersions(t.readerDb, '2024-12-16');
    await recordOfficialEvidence(t.writer, 'it', v!.resultSetId, {
      code: 'partial',
      outcome: 'WARN',
      evidenceRef: 'test://partial',
      performedBy: 'it',
    });
    await recordOfficialEvidence(t.writer, 'it', v!.resultSetId, {
      code: 'full',
      outcome: 'PASS',
      evidenceRef: 'test://full',
      performedBy: 'it',
    });
    await expectPgError(
      verifyResultSet(t.writer, 'it', v!.resultSetId, 'it'),
      CHECK_VIOLATION,
      /no non-PASS evidence/,
    );
  });

  it('official evidence → VERIFIED, current, draw PUBLISHED', async () => {
    const { draw, bytes } = fixtureDraw('2025-01-17');
    const r = created(await importDraw(t, draw, { body: bytes }));
    const v = await verifyWithEvidence(t, r.resultSetId);
    expect(v.becameCurrent).toBe(true);
    const current = await getCurrentResult(t.readerDb, '2025-01-17');
    expect(current).toMatchObject({ verificationStatus: 'VERIFIED', isCurrent: true, version: 1 });
    // The stored result reproduces the canonical draw exactly.
    expect(current!.result).toEqual(draw);
    const { rows } = await t.reader.query("SELECT status FROM draw WHERE draw_date = '2025-01-17'");
    expect(rows[0].status).toBe('PUBLISHED');
  });
});

describe('quarantine paths', () => {
  it('validation failure → QUARANTINED with a reason; needs operator review to verify', async () => {
    const { draw } = fixtureDraw('2020-01-17');
    const bad: DrawResult = {
      ...draw,
      prizes: draw.prizes.map((p) =>
        p.category === 'fourth' ? { ...p, numbers: p.numbers.slice(1) } : p,
      ),
    };
    const r = created(await importDraw(t, bad));
    expect(r.status).toBe('QUARANTINED');
    expect(r.reason).toMatch(/validation_failed: wrong_count/);
    // Even with evidence and review, a VALIDATION failure blocks VERIFIED.
    await recordOfficialEvidence(t.writer, 'it', r.resultSetId, {
      code: 'x',
      outcome: 'PASS',
      evidenceRef: 'test://x',
      performedBy: 'it',
    });
    await recordOperatorReview(t.writer, 'it', r.resultSetId, {
      outcome: 'PASS',
      performedBy: 'it',
      notes: 'n',
    });
    await expectPgError(
      verifyResultSet(t.writer, 'it', r.resultSetId, 'it'),
      CHECK_VIOLATION,
      /VALIDATION failures/,
    );
    await rejectResultSet(t.writer, 'it', r.resultSetId, 'operator: wrong count confirmed');
    expect((await getResultSet(t.readerDb, r.resultSetId))?.verificationStatus).toBe('REJECTED');
  });

  it('a VALIDATED result can be quarantined, then verified only with operator review', async () => {
    const { draw, bytes } = fixtureDraw('2013-02-01');
    const r = created(await importDraw(t, draw, { body: bytes }));
    await quarantineResultSet(
      t.writer,
      'it',
      r.resultSetId,
      'operator: suspicious, double-check PDF',
    );
    await recordOfficialEvidence(t.writer, 'it', r.resultSetId, {
      code: 'pdf',
      outcome: 'PASS',
      evidenceRef: 'test://pdf',
      performedBy: 'it',
    });
    await expectPgError(
      verifyResultSet(t.writer, 'it', r.resultSetId, 'it'),
      CHECK_VIOLATION,
      /OPERATOR_REVIEW/,
    );
    await recordOperatorReview(t.writer, 'it', r.resultSetId, {
      outcome: 'PASS',
      performedBy: 'it',
      notes: 'ok',
    });
    expect((await verifyResultSet(t.writer, 'it', r.resultSetId, 'it')).becameCurrent).toBe(true);
  });

  it('quarantine and reject require a reason', async () => {
    const { draw, bytes } = fixtureDraw('2011-02-01');
    const r = created(await importDraw(t, draw, { body: bytes }));
    await expectPgError(
      quarantineResultSet(t.writer, 'it', r.resultSetId, '  '),
      CHECK_VIOLATION,
      /result_set_reason_required/,
    );
  });

  it('unstorable content is refused before any write, raw payload kept', async () => {
    const { draw } = fixtureDraw('2015-01-16');
    const bad: DrawResult = {
      ...draw,
      prizes: draw.prizes.map((p) =>
        p.category === 'second' ? { ...p, numbers: ['12345', ...p.numbers.slice(1)] } : p,
      ),
    };
    const before = await t.writer.query('SELECT count(*)::int AS n FROM raw_payload');
    await expect(importDraw(t, bad)).rejects.toThrow(UnstorableResultError);
    const after = await t.writer.query('SELECT count(*)::int AS n FROM raw_payload');
    expect(after.rows[0].n).toBe(before.rows[0].n + 1);
    expect(await listVersions(t.readerDb, '2015-01-16')).toEqual([]);
  });
});

describe('lifecycle rules enforced by the database', () => {
  it('result sets cannot be created in any state but PENDING', async () => {
    const { rows } = await t.writer.query(
      'SELECT draw_id, raw_payload_id, prize_structure_id FROM result_set LIMIT 1',
    );
    await expectPgError(
      t.writer.query(
        `INSERT INTO result_set (draw_id, version, prize_structure_id, raw_payload_id, content_hash, verification_status, verified_at, verified_by)
         VALUES ($1, 99, $2, $3, sha256('x'), 'VERIFIED', now(), 'me')`,
        [rows[0].draw_id, rows[0].prize_structure_id, rows[0].raw_payload_id],
      ),
      CHECK_VIOLATION,
      /must be created as PENDING/,
    );
  });

  it('VALIDATION checks cannot be added after PENDING; results cannot gain numbers later', async () => {
    const cur = await getCurrentResult(t.readerDb, '2025-01-17');
    await expectPgError(
      t.writer.query(
        "INSERT INTO verification_check (result_set_id, check_kind, check_code, outcome, performed_by) VALUES ($1, 'VALIDATION', 'late', 'PASS', 'it')",
        [cur!.resultSetId],
      ),
      RESTRICT_VIOLATION,
      /only be recorded while result_set .* is PENDING/,
    );
    await expectPgError(
      t.writer.query(
        "INSERT INTO prize_number (result_set_id, prize_category_id, number) VALUES ($1, 1, '000001')",
        [cur!.resultSetId],
      ),
      RESTRICT_VIOLATION,
      /only be added while result_set .* is PENDING/,
    );
  });

  it('the pointer can only target VERIFIED sets and can never be unset', async () => {
    const versions = await listVersions(t.readerDb, '2024-12-16'); // v1 VALIDATED
    const { rows } = await t.writer.query("SELECT id FROM draw WHERE draw_date = '2024-12-16'");
    await expectPgError(
      t.writer.query(
        "UPDATE draw SET current_result_set_id = $1, status = 'PUBLISHED' WHERE id = $2",
        [versions[0]!.resultSetId, rows[0].id],
      ),
      CHECK_VIOLATION,
      /only point at a VERIFIED/,
    );
    await expectPgError(
      t.writer.query("UPDATE draw SET current_result_set_id = NULL WHERE draw_date = '2025-01-17'"),
      RESTRICT_VIOLATION,
      /cannot be unset/,
    );
  });

  it('the pointer cannot point at another draw’s result set (composite FK)', async () => {
    const other = await getCurrentResult(t.readerDb, '2025-01-17');
    // 2024-12-16 has no current result, so only the composite FK can stop this
    // (the target is VERIFIED, and no correction is needed for a first pointer).
    await expectPgError(
      t.owner.query(
        "UPDATE draw SET current_result_set_id = $1, status = 'PUBLISHED' WHERE draw_date = '2024-12-16'",
        [other!.resultSetId],
      ),
      '23503',
      /draw_current_result_set_fk/,
    );
  });

  it('changing the current result without a correction is refused', async () => {
    const { draw } = fixtureDraw('2025-01-17');
    const r = created(await importDraw(t, variant(draw, '000001')));
    expect(r.status).toBe('QUARANTINED');
    await verifyWithEvidence(t, r.resultSetId, true);
    await expectPgError(
      t.writer.query("UPDATE draw SET current_result_set_id = $1 WHERE draw_date = '2025-01-17'", [
        r.resultSetId,
      ]),
      CHECK_VIOLATION,
      /requires a correction record/,
    );
    // The sanctioned path works and is audited.
    const c = await approveCorrection(t.writer, 'operator:alice', {
      toResultSetId: r.resultSetId,
      reason: 'GLO corrected fifth prize',
      detectedBy: 'reconcile',
      approvedBy: 'alice',
    });
    const now = await getCurrentResult(t.readerDb, '2025-01-17');
    expect(now?.resultSetId).toBe(r.resultSetId);
    expect(checkTicket(now!.result, '000001').wins.map((w) => w.category)).toContain('fifth');
    const audit = await t.owner.query(
      "SELECT actor, db_role FROM audit_log WHERE action = 'correction.create' AND entity_id = $1",
      [String(c.correctionId)],
    );
    expect(audit.rows).toEqual([{ actor: 'operator:alice', db_role: 'lekvero_it_ingest' }]);
  });

  it('every lifecycle change is in the audit log with the runtime login role', async () => {
    const { rows } = await t.owner.query<{ action: string; n: number }>(
      'SELECT action, count(*)::int AS n FROM audit_log GROUP BY action ORDER BY action',
    );
    const actions = Object.fromEntries(rows.map((r) => [r.action, r.n]));
    for (const a of [
      'raw_payload.store',
      'draw.create',
      'result_set.create',
      'result_set.status',
      'draw.set_current',
      'correction.create',
      'verification_check.create',
    ]) {
      expect(actions[a], a).toBeGreaterThan(0);
    }
    const roles = await t.owner.query('SELECT DISTINCT db_role FROM audit_log');
    expect(roles.rows).toEqual([{ db_role: 'lekvero_it_ingest' }]);
  });
});
