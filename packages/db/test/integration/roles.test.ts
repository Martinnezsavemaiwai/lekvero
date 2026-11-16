/**
 * Append-only and least-privilege guarantees, exercised with the REAL runtime
 * roles (reader = API, writer = ingestion) and the migration owner.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getCurrentResult } from '../../src/reads';
import {
  CHECK_VIOLATION,
  PERMISSION_DENIED,
  RESTRICT_VIOLATION,
  expectPgError,
  fixtureDraw,
  freshDatabase,
  importDraw,
  verifyWithEvidence,
} from './helpers';
import type { TestDb } from './helpers';

let t: TestDb;
let rsId: number;
beforeAll(async () => {
  t = await freshDatabase('roles');
  const { draw, bytes } = fixtureDraw('2024-03-01');
  const r = await importDraw(t, draw, { body: bytes });
  rsId = r.resultSetId;
  await verifyWithEvidence(t, rsId);
});
afterAll(() => t.close());

const DATA_TABLES = [
  'raw_payload',
  'import_run',
  'draw',
  'result_set',
  'result_prize',
  'prize_number',
  'verification_check',
  'correction',
  'audit_log',
];

describe('reader role (public API)', () => {
  it('can read published results', async () => {
    const current = await getCurrentResult(t.readerDb, '2024-03-01');
    expect(current?.verificationStatus).toBe('VERIFIED');
  });

  it.each(['raw_payload', 'import_run', 'audit_log'])('cannot read %s', async (table) => {
    await expectPgError(t.reader.query(`SELECT 1 FROM ${table} LIMIT 1`), PERMISSION_DENIED);
  });

  it.each(DATA_TABLES)('cannot INSERT into %s', async (table) => {
    await expectPgError(t.reader.query(`INSERT INTO ${table} DEFAULT VALUES`), PERMISSION_DENIED);
  });

  it('cannot UPDATE or DELETE anything', async () => {
    await expectPgError(t.reader.query("UPDATE draw SET status = 'CANCELLED'"), PERMISSION_DENIED);
    await expectPgError(t.reader.query('DELETE FROM prize_number'), PERMISSION_DENIED);
  });

  it('cannot create objects', async () => {
    await expectPgError(t.reader.query('CREATE TABLE x (id int)'), PERMISSION_DENIED);
  });
});

describe('writer role (ingestion)', () => {
  it.each(DATA_TABLES)('cannot DELETE from %s', async (table) => {
    await expectPgError(t.writer.query(`DELETE FROM ${table}`), PERMISSION_DENIED);
  });

  it.each(DATA_TABLES)('cannot TRUNCATE %s', async (table) => {
    await expectPgError(t.writer.query(`TRUNCATE ${table}`), PERMISSION_DENIED);
  });

  it.each([
    ['prize_number', "number = '000000'"],
    ['result_prize', 'amount_baht = 1'],
    ['raw_payload', "provenance = 'x'"],
    ['verification_check', "outcome = 'PASS'"],
    ['result_set', 'content_hash = content_hash'],
    ['result_set', 'version = 99'],
    ['draw', "draw_date = '2000-01-01'"],
  ])('cannot UPDATE %s SET %s', async (table, set) => {
    await expectPgError(t.writer.query(`UPDATE ${table} SET ${set}`), PERMISSION_DENIED);
  });

  it('cannot write the audit log', async () => {
    await expectPgError(
      t.writer.query(
        "INSERT INTO audit_log (actor, db_role, action, entity_type, entity_id) VALUES ('x','x','x','x','x')",
      ),
      PERMISSION_DENIED,
    );
  });

  it('cannot modify reference data', async () => {
    await expectPgError(t.writer.query('UPDATE prize_category SET digits = 6'), PERMISSION_DENIED);
    await expectPgError(
      t.writer.query("INSERT INTO prize_structure (code, description) VALUES ('X','x')"),
      PERMISSION_DENIED,
    );
  });

  it('even an allowed lifecycle column cannot be changed illegally (trigger)', async () => {
    await expectPgError(
      t.writer.query(
        "UPDATE result_set SET verification_status = 'REJECTED', status_reason = 'x' WHERE id = $1",
        [rsId],
      ),
      CHECK_VIOLATION,
      /illegal transition VERIFIED → REJECTED/,
    );
  });

  it('cannot create objects', async () => {
    await expectPgError(t.writer.query('CREATE TABLE x (id int)'), PERMISSION_DENIED);
  });
});

describe('migration owner is also bound by append-only triggers', () => {
  it.each([
    ['UPDATE prize_number SET number = number', /UPDATE on prize_number is not allowed/],
    ['DELETE FROM prize_number', /DELETE on prize_number is not allowed/],
    ['UPDATE raw_payload SET provenance = provenance', /UPDATE on raw_payload/],
    ['DELETE FROM result_set', /DELETE on result_set/],
    ['DELETE FROM draw', /DELETE on draw/],
    ['TRUNCATE audit_log', /TRUNCATE on audit_log/],
    ['UPDATE audit_log SET actor = actor', /UPDATE on audit_log/],
  ])('%s is refused', async (sql, msg) => {
    await expectPgError(t.owner.query(sql), RESTRICT_VIOLATION, msg);
  });

  it('result content (hash) is immutable even for the owner', async () => {
    await expectPgError(
      t.owner.query("UPDATE result_set SET content_hash = sha256('x') WHERE id = $1", [rsId]),
      RESTRICT_VIOLATION,
      /content is immutable/,
    );
  });
});
