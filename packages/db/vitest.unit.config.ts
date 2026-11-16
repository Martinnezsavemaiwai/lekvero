import { defineProject } from 'vitest/config';

export default defineProject({ test: { name: 'db', include: ['test/unit/**/*.test.ts'] } });
