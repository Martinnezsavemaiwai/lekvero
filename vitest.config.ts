import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/shared', 'packages/db/vitest.unit.config.ts', 'apps/api'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**', 'apps/api/src/**'],
    },
  },
});
