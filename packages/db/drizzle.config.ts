import { defineConfig } from 'drizzle-kit';

// Only `generate` and `check` are used (offline). Migrations are applied with
// `pnpm db:migrate`, never by drizzle-kit push and never on app startup.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './migrations',
  strict: true,
  verbose: true,
});
