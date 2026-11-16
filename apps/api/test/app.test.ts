import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';

describe('api', () => {
  it('GET /health', async () => {
    const app = buildApp({ LOG_LEVEL: 'silent' });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toEqual({
      status: 'ok',
      service: 'lekvero-api',
      supportedPrizeStructures: ['LEGACY_LAST3X4', 'MODERN_FRONT3_BACK3'],
    });
    await app.close();
  });

  it('unknown routes 404', async () => {
    const app = buildApp({ LOG_LEVEL: 'silent' });
    expect((await app.inject({ method: 'GET', url: '/nope' })).statusCode).toBe(404);
    await app.close();
  });
});

describe('config', () => {
  it('applies defaults', () => {
    expect(loadConfig({})).toEqual({ API_HOST: '127.0.0.1', API_PORT: 4000, LOG_LEVEL: 'info' });
  });
  it('rejects an invalid port', () => {
    expect(() => loadConfig({ API_PORT: '70000' })).toThrow();
  });
});
