// pnpm db:migrate — apply pending migrations as the migration owner.
import { runMigrations } from '../migrate';
import { requireEnv } from './env';

await runMigrations(requireEnv('MIGRATION_DATABASE_URL'));
console.log('Migrations applied.');
