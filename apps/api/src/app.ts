import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { PRIZE_STRUCTURE_CODES } from '@lekvero/shared';
import type { ApiConfig } from './config';

/**
 * Builds the read-only API. M1 exposes only /health; lottery endpoints arrive
 * in M7 (docs/planning/implementation-roadmap.md).
 */
export function buildApp(config: Pick<ApiConfig, 'LOG_LEVEL'>): FastifyInstance {
  const app = Fastify({ logger: { level: config.LOG_LEVEL } });

  app.get('/health', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
    return {
      status: 'ok',
      service: 'lekvero-api',
      // Proves the shared workspace package is wired in.
      supportedPrizeStructures: PRIZE_STRUCTURE_CODES,
    };
  });

  return app;
}
