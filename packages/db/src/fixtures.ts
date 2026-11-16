/**
 * LOCAL/TEST ONLY: load the archived GLO fixtures (fixtures/glo/v1) through the
 * real import path. Guarded by assertFixtureSeedingAllowed().
 *
 * Every draw ends up VALIDATED. Only 2024-03-01 becomes VERIFIED, because it is
 * the only draw with archived official checker responses to use as evidence —
 * demonstrating that a schema-valid result is not automatically verified.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type pg from 'pg';
import {
  GloByDateEnvelopeSchema,
  GloCheckEnvelopeSchema,
  GloLatestEnvelopeSchema,
  crosscheckWithGloChecker,
  mapGloDraw,
  validateDrawResult,
} from '@lekvero/shared';
import type { GloDraw } from '@lekvero/shared';
import { assertFixtureSeedingAllowed } from './env-guard';
import { finishImportRun, recordImport, startImportRun } from './imports';
import type { RecordImportOutcome } from './imports';
import { recordOfficialEvidence, verifyResultSet } from './lifecycle';
import { storeRawPayload } from './raw-payload';

interface ManifestEntry {
  path: string;
  sha256: string;
  kind: 'live' | 'synthetic';
  endpoint?: string;
  request?: Record<string, unknown> | null;
  retrieved_at?: string;
  response_headers?: Record<string, string>;
}

export interface SeedReport {
  readonly draws: Array<{
    drawDate: string;
    outcome: RecordImportOutcome['outcome'];
    version: number;
    status: string;
  }>;
  readonly verified: string[];
}

const ACTOR = 'fixture-seed';

export async function seedFixtures(
  writerPool: pg.Pool,
  opts: { fixtureRoot: string; connectionString: string; env?: NodeJS.ProcessEnv },
): Promise<SeedReport> {
  assertFixtureSeedingAllowed(opts.env ?? process.env, opts.connectionString);
  const manifest = JSON.parse(readFileSync(join(opts.fixtureRoot, 'manifest.json'), 'utf8')) as {
    files: ManifestEntry[];
  };
  const read = (e: ManifestEntry): Buffer => {
    const bytes = readFileSync(join(opts.fixtureRoot, e.path));
    if (createHash('sha256').update(bytes).digest('hex') !== e.sha256) {
      throw new Error(`Fixture ${e.path} does not match its manifest SHA-256`);
    }
    return bytes;
  };

  const runId = await startImportRun(writerPool, ACTOR, 'glo_api', 'fixture');
  const report: SeedReport = { draws: [], verified: [] };
  const draws = manifest.files.filter(
    (f) =>
      f.kind === 'live' &&
      (f.path.startsWith('live/latest/') ||
        (f.path.startsWith('live/result-by-date/') && !f.path.endsWith('.null.json'))),
  );

  try {
    for (const entry of draws) {
      const bytes = read(entry);
      const json: unknown = JSON.parse(bytes.toString('utf8'));
      const raw: GloDraw = entry.path.startsWith('live/latest/')
        ? GloLatestEnvelopeSchema.parse(json).response
        : GloByDateEnvelopeSchema.parse(json).response!.result;

      const stored = await storeRawPayload(writerPool, ACTOR, {
        sourceCode: 'glo_api',
        endpoint: entry.endpoint ?? 'unknown',
        requestMethod: 'POST',
        requestParams: entry.request ?? {},
        httpStatus: 200,
        fetchedAt: new Date(entry.retrieved_at ?? 0),
        contentType: 'application/json; charset=utf-8',
        responseHeaders: entry.response_headers ?? {},
        body: bytes,
        provenance: `fixture:fixtures/glo/v1/${entry.path} (archived ${entry.retrieved_at ?? 'unknown'})`,
        importRunId: runId,
      });
      const result = mapGloDraw(raw);
      const outcome = await recordImport(writerPool, ACTOR, {
        rawPayloadId: stored.id,
        importRunId: runId,
        result,
        validation: validateDrawResult(result),
      });
      report.draws.push({
        drawDate: result.drawDate,
        outcome: outcome.outcome,
        version: outcome.version,
        status: outcome.outcome === 'created' ? outcome.status : 'unchanged',
      });

      // Official evidence: archived GLO checker responses for the same draw, if any.
      const checkEntries = manifest.files.filter(
        (f) => f.kind === 'live' && f.path.startsWith(`live/check/${result.drawDate}_`),
      );
      if (
        outcome.outcome === 'created' &&
        outcome.status === 'VALIDATED' &&
        checkEntries.length > 0
      ) {
        const envelopes = checkEntries.map((e) =>
          GloCheckEnvelopeSchema.parse(JSON.parse(read(e).toString('utf8'))),
        );
        const cc = crosscheckWithGloChecker(result, envelopes);
        await recordOfficialEvidence(writerPool, ACTOR, outcome.resultSetId, {
          code: 'archived_glo_checker_crosscheck',
          outcome: cc.agrees ? 'PASS' : 'FAIL',
          evidenceRef: checkEntries
            .map((e) => `fixtures/glo/v1/${e.path}#sha256=${e.sha256}`)
            .join(' '),
          performedBy: 'system:fixture-seed',
          details: { checkedNumbers: cc.checkedNumbers, mismatches: cc.mismatches },
        });
        if (cc.agrees) {
          await verifyResultSet(writerPool, ACTOR, outcome.resultSetId, 'system:fixture-seed');
          report.verified.push(result.drawDate);
        }
      }
    }
    await finishImportRun(writerPool, ACTOR, runId, 'SUCCEEDED', { draws: report.draws.length });
    return report;
  } catch (err) {
    await finishImportRun(writerPool, ACTOR, runId, 'FAILED', {}, String(err));
    throw err;
  }
}
