// pnpm db:verify-migrations — offline migration safety checks (no database needed).
//
//  1. Journal ↔ files: every journal entry has a .sql file and vice versa.
//  2. Forward-only: every recorded migration still matches migrations/CHECKSUMS.json.
//     New migrations must be recorded explicitly with `--record` (never rewrites old entries).
//  3. No destructive statements (DROP TABLE/COLUMN/TYPE, TRUNCATE, DELETE, ALTER COLUMN … TYPE).
//  4. drizzle-kit check passes, and regenerating from src/schema.ts yields NO new migration
//     (i.e. the committed SQL matches the Drizzle schema).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATIONS = join(PKG, 'migrations');
const CHECKSUMS = join(MIGRATIONS, 'CHECKSUMS.json');
const record = process.argv.includes('--record');
const failures: string[] = [];

const sqlFiles = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta/_journal.json'), 'utf8')) as {
  entries: Array<{ idx: number; tag: string }>;
};

// 1
const journalFiles = journal.entries.map((e) => `${e.tag}.sql`);
for (const f of journalFiles)
  if (!sqlFiles.includes(f)) failures.push(`journal entry without file: ${f}`);
for (const f of sqlFiles)
  if (!journalFiles.includes(f)) failures.push(`migration file not in journal: ${f}`);
journal.entries.forEach((e, i) => {
  if (e.idx !== i) failures.push(`journal idx out of order at ${e.tag}`);
});

// 2
const sha = (f: string) =>
  createHash('sha256')
    .update(readFileSync(join(MIGRATIONS, f)))
    .digest('hex');
const recorded: Record<string, string> = existsSync(CHECKSUMS)
  ? (JSON.parse(readFileSync(CHECKSUMS, 'utf8')) as Record<string, string>)
  : {};
for (const [f, h] of Object.entries(recorded)) {
  if (!sqlFiles.includes(f)) failures.push(`recorded migration was deleted: ${f}`);
  else if (sha(f) !== h) failures.push(`recorded migration was modified (forward-only!): ${f}`);
}
const unrecorded = sqlFiles.filter((f) => !(f in recorded));
if (unrecorded.length > 0) {
  if (record) {
    for (const f of unrecorded) recorded[f] = sha(f);
    writeFileSync(CHECKSUMS, `${JSON.stringify(recorded, null, 2)}\n`);
    console.log(`Recorded checksums for: ${unrecorded.join(', ')}`);
  } else {
    failures.push(
      `unrecorded migrations (run with --record after review): ${unrecorded.join(', ')}`,
    );
  }
}

// 3
// TRUNCATE / DELETE only as statements (line start), so trigger definitions such as
// "BEFORE TRUNCATE ON …" (which *prevent* truncation) are not flagged.
const DESTRUCTIVE =
  /\bDROP\s+(TABLE|COLUMN|TYPE|SCHEMA|INDEX|CONSTRAINT)\b|^\s*TRUNCATE\b|^\s*DELETE\s+FROM\b|\bALTER\s+COLUMN\s+\S+\s+(SET\s+DATA\s+)?TYPE\b/im;
for (const f of sqlFiles) {
  const body = readFileSync(join(MIGRATIONS, f), 'utf8')
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('--'))
    .join('\n');
  const m = body.match(DESTRUCTIVE);
  if (m)
    failures.push(
      `destructive statement in ${f}: "${m[0]}" (not allowed in M3; needs explicit review)`,
    );
}

// 4
const kit = (args: string[]) =>
  execFileSync('pnpm', ['exec', 'drizzle-kit', ...args], {
    cwd: PKG,
    encoding: 'utf8',
    stdio: 'pipe',
  });
try {
  kit(['check', '--dialect', 'postgresql', '--out', 'migrations']);
} catch (e) {
  failures.push(`drizzle-kit check failed: ${(e as { stdout?: string }).stdout ?? e}`);
}
// drizzle-kit mangles absolute --out paths and may exit 0 on errors, so use a
// package-relative scratch dir and require a positive signal either way.
const tmpRel = mkdtempSync(join(PKG, '.drift-')).slice(PKG.length + 1);
const tmp = join(PKG, tmpRel);
try {
  cpSync(MIGRATIONS, tmp, { recursive: true });
  const out = kit([
    'generate',
    '--dialect',
    'postgresql',
    '--schema',
    'src/schema.ts',
    '--out',
    tmpRel,
    '--name',
    'drift',
  ]);
  const extra = readdirSync(tmp).filter((f) => f.endsWith('.sql') && !sqlFiles.includes(f));
  if (extra.length > 0) {
    failures.push(
      `schema drift: src/schema.ts differs from committed migrations (would generate ${extra.join(', ')}):\n` +
        readFileSync(join(tmp, extra[0]!), 'utf8'),
    );
  } else if (!/No schema changes/i.test(out)) {
    failures.push(`could not verify schema drift; drizzle-kit output:\n${out}`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`Migration verification FAILED:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(`Migration verification passed (${sqlFiles.length} migrations).`);
