// pnpm db:seed:fixtures — LOCAL/TEST ONLY (LEKVERO_ENV=local|test, loopback host).
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool } from '../client';
import { seedFixtures } from '../fixtures';
import { requireEnv } from './env';

const url = requireEnv('INGEST_DATABASE_URL');
const pool = createPool(url, 'lekvero-seed');
try {
  const report = await seedFixtures(pool, {
    connectionString: url,
    fixtureRoot: resolve(dirname(fileURLToPath(import.meta.url)), '../../../../fixtures/glo/v1'),
  });
  console.table(report.draws);
  console.log(
    `VERIFIED via archived official checker evidence: ${report.verified.join(', ') || 'none'}`,
  );
} finally {
  await pool.end();
}
