import { EnvironmentNotAllowedError } from './errors';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Archived GLO responses may be loaded only into local/test databases until
 * GLO clarifies licensing (docs/legal/). Requires LEKVERO_ENV=local|test AND a
 * loopback database host.
 */
export function assertFixtureSeedingAllowed(
  env: NodeJS.ProcessEnv,
  connectionString: string,
): void {
  const mode = env.LEKVERO_ENV;
  if (mode !== 'local' && mode !== 'test') {
    throw new EnvironmentNotAllowedError(
      `Fixture seeding requires LEKVERO_ENV=local or test (got ${JSON.stringify(mode)}).`,
    );
  }
  const host = new URL(connectionString).hostname;
  if (!LOOPBACK.has(host)) {
    throw new EnvironmentNotAllowedError(
      `Fixture seeding is only allowed on a loopback host (got ${host}).`,
    );
  }
}
