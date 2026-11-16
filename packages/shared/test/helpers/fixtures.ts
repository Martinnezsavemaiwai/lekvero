import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../fixtures/glo/v1',
);

export interface ManifestEntry {
  path: string;
  sha256: string;
  kind: 'live' | 'synthetic';
  endpoint?: string;
  request?: unknown;
}

export function readFixtureText(rel: string): string {
  return readFileSync(join(FIXTURE_ROOT, rel), 'utf8');
}
export function readFixture(rel: string): unknown {
  return JSON.parse(readFixtureText(rel));
}
export function manifest(): { files: ManifestEntry[] } {
  return readFixture('manifest.json') as { files: ManifestEntry[] };
}
export function sha256(rel: string): string {
  return createHash('sha256')
    .update(readFileSync(join(FIXTURE_ROOT, rel)))
    .digest('hex');
}
