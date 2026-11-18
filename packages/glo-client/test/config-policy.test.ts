import { describe, expect, it } from 'vitest';
import {
  CircuitBreaker,
  DEFAULT_POLICY,
  DEFAULT_USER_AGENT,
  GloCircuitOpenError,
  GloOfflineGuardError,
  NodeHttpTransport,
  PROJECT_URL,
  RateLimiter,
  assertOfflineTarget,
  backoffDelayMs,
  parseRetryAfterMs,
  resolveConfig,
} from '../src';
import { FakeClock } from './helpers/fake-glo';

describe('offline guard (M4: no live access)', () => {
  it.each([
    'https://www.glo.or.th',
    'https://glo.or.th/api',
    'https://gdcatalog.glo.or.th',
    'https://api.glo.or.th',
    'http://10.0.0.5:8080',
    'http://example.com',
    'http://127.0.0.1.nip.io',
  ])('refuses %s', (url) => {
    expect(() => resolveConfig({ baseUrl: url })).toThrow(GloOfflineGuardError);
  });

  it.each(['ftp://127.0.0.1', 'not a url', 'http://user:pw@127.0.0.1'])('refuses %s', (url) => {
    expect(() => assertOfflineTarget(url)).toThrow(GloOfflineGuardError);
  });

  it.each(['http://127.0.0.1:1234', 'http://localhost:9', 'http://[::1]:80'])(
    'allows %s',
    (url) => {
      expect(() => assertOfflineTarget(url)).not.toThrow();
    },
  );

  it('the transport itself refuses a GLO URL before connecting (defence in depth)', async () => {
    await expect(
      new NodeHttpTransport().request({
        url: new URL('https://www.glo.or.th/api/lottery/getLatestLottery'),
        method: 'POST',
        headers: {},
        body: new Uint8Array(),
        timeoutMs: 1000,
        maxResponseBytes: 1000,
      }),
    ).rejects.toThrow(GloOfflineGuardError);
  });
});

describe('config', () => {
  it('defaults to the conservative policy specification', () => {
    const c = resolveConfig({ baseUrl: 'http://127.0.0.1:1' });
    expect(c).toMatchObject({
      minIntervalMs: 5_000,
      timeoutMs: 30_000,
      maxResponseBytes: 1_048_576,
      retry: { maxAttempts: 5, baseDelayMs: 2_000, maxDelayMs: 60_000, totalBudgetMs: 180_000 },
      circuit: { failureThreshold: 5, cooldownMs: 600_000 },
      userAgent: DEFAULT_USER_AGENT,
    });
    expect(DEFAULT_USER_AGENT).toContain(PROJECT_URL);
  });

  it('enforces the 2 s interval floor unless the loopback test flag is set', () => {
    expect(resolveConfig({ baseUrl: 'http://127.0.0.1:1', minIntervalMs: 0 }).minIntervalMs).toBe(
      DEFAULT_POLICY.minIntervalFloorMs,
    );
    expect(
      resolveConfig({
        baseUrl: 'http://127.0.0.1:1',
        minIntervalMs: 0,
        allowFastIntervalForLoopbackTests: true,
      }).minIntervalMs,
    ).toBe(0);
  });

  it('cannot raise the response cap above 1 MiB or the timeout above 120 s', () => {
    expect(() =>
      resolveConfig({ baseUrl: 'http://127.0.0.1:1', maxResponseBytes: 1_048_577 }),
    ).toThrow();
    expect(() => resolveConfig({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 120_001 })).toThrow();
  });
});

describe('backoff', () => {
  it('is full-jitter exponential and capped', () => {
    expect([1, 2, 3, 4].map((a) => backoffDelayMs(a, 0.5, 1000, 60_000))).toEqual([
      500, 1000, 2000, 4000,
    ]);
    expect(backoffDelayMs(10, 0.999999, 1000, 60_000)).toBeLessThan(60_000);
    expect(backoffDelayMs(3, 0, 1000, 60_000)).toBe(0);
    expect(backoffDelayMs(1, 5, 1000, 60_000)).toBeLessThan(1000); // clamps bad random
  });
});

describe('Retry-After parsing', () => {
  const now = Date.parse('2026-11-16T09:00:00Z');
  it.each([
    ['3', 3000],
    ['0', 0],
    ['Mon, 16 Nov 2026 09:00:10 GMT', 10_000],
    ['Mon, 16 Nov 2026 08:00:00 GMT', 0],
    ['soon', null],
    [undefined, null],
  ])('%j → %j', (v, ms) => {
    expect(parseRetryAfterMs(v, now)).toBe(ms);
  });
});

describe('RateLimiter', () => {
  it('spaces request starts and runs strictly one at a time (FIFO)', async () => {
    const clock = new FakeClock();
    const rl = new RateLimiter(5000, clock);
    const starts: number[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const job = (id: number) => async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      starts.push(id);
      await Promise.resolve();
      clock.t += 100; // simulated work
      inFlight--;
      return id;
    };
    const results = await Promise.all([rl.run(job(1)), rl.run(job(2)), rl.run(job(3))]);
    expect(results).toEqual([1, 2, 3]);
    expect(starts).toEqual([1, 2, 3]);
    expect(maxInFlight).toBe(1);
    expect(clock.sleeps).toEqual([4900, 4900]);
  });

  it('a failing job does not block later callers', async () => {
    const clock = new FakeClock();
    const rl = new RateLimiter(0, clock);
    await expect(rl.run(async () => Promise.reject(new Error('x')))).rejects.toThrow('x');
    await expect(rl.run(async () => 'ok')).resolves.toBe('ok');
  });
});

describe('CircuitBreaker', () => {
  it('opens at the threshold, half-opens after cooldown with exactly one trial', () => {
    const clock = new FakeClock();
    const cb = new CircuitBreaker(2, 1000, clock);
    cb.beforeCall();
    cb.onFailure();
    expect(cb.state).toBe('closed');
    cb.beforeCall();
    cb.onFailure();
    expect(cb.state).toBe('open');
    expect(() => cb.beforeCall()).toThrow(GloCircuitOpenError);
    clock.t += 1000;
    expect(cb.state).toBe('half_open');
    cb.beforeCall(); // the single trial
    expect(() => cb.beforeCall()).toThrow(GloCircuitOpenError);
    cb.onFailure(); // trial failed → open again, cooldown restarts
    expect(cb.state).toBe('open');
    clock.t += 1000;
    cb.beforeCall();
    cb.onSuccess();
    expect(cb.state).toBe('closed');
  });

  it('a neutral outcome during half-open closes the circuit (upstream answered)', () => {
    const clock = new FakeClock();
    const cb = new CircuitBreaker(1, 10, clock);
    cb.onFailure();
    clock.t += 10;
    cb.beforeCall();
    cb.onNeutral();
    expect(cb.state).toBe('closed');
  });
});
