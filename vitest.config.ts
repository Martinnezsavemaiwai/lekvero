import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/api'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**', 'apps/api/src/**'],
    },
  },
});
