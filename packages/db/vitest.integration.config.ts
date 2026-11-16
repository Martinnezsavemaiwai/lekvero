import { defineProject } from 'vitest/config';

// Requires DATABASE_URL (an admin/superuser connection to a PostgreSQL 17 server).
// Run from the repo root: pnpm test:db
export default defineProject({
  test: {
    name: 'db-integration',
    root: import.meta.dirname,
    include: ['test/integration/**/*.test.ts'],
    globalSetup: ['test/integration/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
