import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'glo-client', include: ['test/**/*.test.ts'], testTimeout: 10_000 },
});
