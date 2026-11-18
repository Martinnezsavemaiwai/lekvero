import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GloByDateEnvelopeSchema, GloLatestEnvelopeSchema, mapGloDraw } from '@lekvero/shared';
import {
  GloCircuitOpenError,
  GloClient,
  GloHttpError,
  GloInvalidRequestError,
  GloNetworkError,
  GloPayloadTooLargeError,
  GloRateLimitedError,
  GloSchemaError,
  GloTimeoutError,
} from '../src';
import type { GloClientConfigInput, HttpTransport } from '../src';
import { FakeClock, FakeGlo, fixture } from './helpers/fake-glo';

let glo: FakeGlo;
let clock: FakeClock;
beforeEach(async () => {
  glo = await new FakeGlo().start();
  clock = new FakeClock();
});
afterEach(() => glo.stop());

/** Fast, deterministic settings: no spacing, small backoff, random fixed at 0.5. */
const client = (over: Partial<GloClientConfigInput> = {}) =>
  new GloClient(
    {
      baseUrl: glo.baseUrl,
      minIntervalMs: 0,
      allowFastIntervalForLoopbackTests: true,
      timeoutMs: 2_000,
      retry: { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 10_000, totalBudgetMs: 60_000 },
      ...over,
    },
    { clock, random: () => 0.5 },
  );

const DRAW_DATES = [
  '2011-02-01',
  '2013-02-01',
  '2015-01-16',
  '2020-01-17',
  '2024-03-01',
  '2024-12-16',
  '2025-01-17',
];
const latestBytes = fixture('live/latest/2026-11-16.json');

describe('contract: archived fixtures round-trip through the client', () => {
  it('getLatest returns the exact bytes and the mapped draw', async () => {
    glo.enqueue({ type: 'body', body: latestBytes });
    const out = await client().getLatest();
    expect(Buffer.compare(out.raw.body, latestBytes)).toBe(0);
    expect(out.draw).toEqual(
      mapGloDraw(GloLatestEnvelopeSchema.parse(JSON.parse(latestBytes.toString())).response),
    );
    expect(out.draw.prizes.find((p) => p.category === 'first')?.numbers).toEqual(['645654']);
    expect(out.unknownKeys).toEqual([]);
    expect(out.raw).toMatchObject({
      endpoint: 'getLatestLottery',
      httpStatus: 200,
      attempts: 1,
      requestParams: null,
    });
  });

  it.each(DRAW_DATES)('getResultByDate(%s) equals the M2 mapping of the fixture', async (date) => {
    const bytes = fixture(`live/result-by-date/${date}.json`);
    glo.enqueue({ type: 'body', body: bytes });
    const out = await client().getResultByDate(date);
    if (out.kind !== 'draw') throw new Error('expected draw');
    expect(out.draw).toEqual(
      mapGloDraw(GloByDateEnvelopeSchema.parse(JSON.parse(bytes.toString())).response!.result),
    );
    expect(Buffer.compare(out.raw.body, bytes)).toBe(0);
  });

  it.each(['2024-03-05', '2007-01-16', '2024-12-30'])(
    'a null response for %s is not_published',
    async (date) => {
      glo.enqueue({ type: 'body', body: fixture(`live/result-by-date/${date}.null.json`) });
      const out = await client().getResultByDate(date);
      expect(out.kind).toBe('not_published');
    },
  );

  it('checkNumbers returns GLO verdicts unchanged', async () => {
    glo.enqueue({ type: 'body', body: fixture('live/check/2024-03-01_winners.json') });
    const out = await client().checkNumbers('2024-03-01', ['253603', '000079', '253602']);
    expect(out.envelope.response.result.map((r) => [r.number, r.statusType])).toEqual([
      ['253603', 1],
      ['000079', 1],
      ['253602', 1],
    ]);
  });
});

describe('requests sent', () => {
  it('use POST, the documented paths and bodies, and identify the project', async () => {
    glo.enqueue(
      { type: 'body', body: latestBytes },
      { type: 'body', body: fixture('live/result-by-date/2024-03-01.json') },
      { type: 'body', body: fixture('live/check/2024-03-01_nonwinner.json') },
    );
    const c = client();
    await c.getLatest();
    await c.getResultByDate('2024-03-01');
    await c.checkNumbers('2024-03-01', ['123456']);
    expect(glo.requests.map((r) => [r.method, r.path, r.body])).toEqual([
      ['POST', '/api/lottery/getLatestLottery', ''],
      ['POST', '/api/checking/getLotteryResult', '{"date":"01","month":"03","year":"2024"}'],
      [
        'POST',
        '/api/checking/getcheckLotteryResult',
        '{"number":[{"lottery_num":"123456"}],"period_date":"2024-03-01"}',
      ],
    ]);
    for (const r of glo.requests) {
      expect(r.headers['content-type']).toBe('application/json');
      expect(r.headers['user-agent']).toMatch(
        /^Lekvero\/.+github\.com\/Martinnezsavemaiwai\/lekvero/,
      );
      expect(r.headers.cookie).toBeUndefined();
      expect(r.headers.authorization).toBeUndefined();
    }
  });

  it.each([
    ['empty list', '2024-03-01', []],
    ['11 numbers', '2024-03-01', Array.from({ length: 11 }, (_, i) => String(i).padStart(6, '0'))],
    ['5 digits', '2024-03-01', ['12345']],
    ['Thai digits', '2024-03-01', ['๑๒๓๔๕๖']],
    ['duplicates', '2024-03-01', ['123456', '123456']],
    ['bad date', '2024-02-30', ['123456']],
  ])(
    'invalid checker request (%s) is rejected without any network call',
    async (_l, date, nums) => {
      await expect(client().checkNumbers(date, nums)).rejects.toThrow(GloInvalidRequestError);
      expect(glo.requests).toHaveLength(0);
    },
  );

  it.each(['2024-3-1', '01-03-2024', '2567-03-01x', ''])(
    'invalid date %j is rejected locally',
    async (d) => {
      await expect(client().getResultByDate(d)).rejects.toThrow(GloInvalidRequestError);
      expect(glo.requests).toHaveLength(0);
    },
  );
});

describe('response handling', () => {
  it('keeps only allow-listed headers (never cookies)', async () => {
    glo.enqueue({
      type: 'body',
      body: latestBytes,
      headers: {
        'Set-Cookie': 'TS01402785=abc; Path=/',
        'X-Cache': 'HIT',
        'Cache-Control': 'must-revalidate, private, max-age=1800',
        'X-Powered-By': 'x',
      },
    });
    const out = await client().getLatest();
    // 'connection', 'keep-alive', 'set-cookie', 'x-powered-by' are all dropped.
    expect(Object.keys(out.raw.responseHeaders).sort()).toEqual([
      'cache-control',
      'content-length',
      'content-type',
      'date',
      'x-cache',
    ]);
    expect(JSON.stringify(out.raw)).not.toMatch(/TS01402785|set-cookie/i);
  });

  it('reports unknown upstream keys as a drift signal without failing', async () => {
    const json = JSON.parse(latestBytes.toString());
    json.response.newField = { added: true };
    glo.enqueue({ type: 'body', body: JSON.stringify(json) });
    expect((await client().getLatest()).unknownKeys).toEqual(['newField']);
  });

  it.each([
    ['missing-first.json', /documented GLO contract/],
    ['numeric-value.json', /documented GLO contract/],
    ['bad-price.json', /documented GLO contract/],
    ['status-false.json', /documented GLO contract/],
  ])(
    'synthetic malformed %s → GloSchemaError carrying raw bytes, not retried',
    async (file, msg) => {
      const bytes = fixture(`synthetic/malformed/${file}`);
      glo.enqueue({ type: 'body', body: bytes });
      const err = await client()
        .getResultByDate('2024-03-01')
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GloSchemaError);
      expect((err as GloSchemaError).message).toMatch(msg);
      expect((err as GloSchemaError).issues.length).toBeGreaterThan(0);
      expect(Buffer.compare((err as GloSchemaError).raw.body, bytes)).toBe(0);
      expect(glo.requests).toHaveLength(1);
    },
  );

  it.each([
    ['truncated JSON', fixture('synthetic/malformed/truncated.json.txt')],
    ['invalid UTF-8', Buffer.from([0x7b, 0xff, 0xfe, 0x7d])],
    ['HTML error page', Buffer.from('<html>Request Rejected</html>')],
  ])('%s → invalid_json', async (_l, body) => {
    glo.enqueue({ type: 'body', body });
    const err = (await client()
      .getLatest()
      .catch((e: unknown) => e)) as GloSchemaError;
    expect(err).toBeInstanceOf(GloSchemaError);
    expect(err.issues).toEqual(['invalid_json']);
  });

  it('a draw for a different date than requested is rejected', async () => {
    glo.enqueue({ type: 'body', body: fixture('live/result-by-date/2024-03-01.json') });
    const err = (await client()
      .getResultByDate('2024-03-16')
      .catch((e: unknown) => e)) as GloSchemaError;
    expect(err.issues).toEqual(['date_mismatch']);
  });

  it('an unknown prize structure is rejected as unmappable', async () => {
    const json = JSON.parse(latestBytes.toString());
    json.response.data.last3f.number = json.response.data.last3f.number.slice(0, 1);
    glo.enqueue({ type: 'body', body: JSON.stringify(json) });
    const err = (await client()
      .getLatest()
      .catch((e: unknown) => e)) as GloSchemaError;
    expect(err.issues).toEqual(['unmappable']);
  });

  it('checker verdicts for other numbers than requested are rejected', async () => {
    glo.enqueue({ type: 'body', body: fixture('live/check/2024-03-01_nonwinner.json') });
    const err = (await client()
      .checkNumbers('2024-03-01', ['654321'])
      .catch((e: unknown) => e)) as GloSchemaError;
    expect(err.issues).toEqual(['number_mismatch']);
  });
});

describe('retries and backoff (deterministic clock)', () => {
  it('retries connection resets with full-jitter backoff, then succeeds', async () => {
    glo.enqueue({ type: 'reset' }, { type: 'reset' }, { type: 'body', body: latestBytes });
    const out = await client().getLatest();
    expect(out.raw.attempts).toBe(3);
    expect(clock.sleeps).toEqual([50, 100]); // 0.5 × 100, 0.5 × 200
  });

  it('retries 5xx up to maxAttempts, then throws GloHttpError', async () => {
    glo.enqueue({ type: 'status', status: 503 });
    await expect(client().getLatest()).rejects.toThrow(GloHttpError);
    expect(glo.requests).toHaveLength(5);
    expect(clock.sleeps).toEqual([50, 100, 200, 400]);
  });

  it.each([400, 403, 404])('does not retry HTTP %i', async (status) => {
    glo.enqueue({ type: 'status', status });
    const err = (await client()
      .getLatest()
      .catch((e: unknown) => e)) as GloHttpError;
    expect(err).toBeInstanceOf(GloHttpError);
    expect(err.status).toBe(status);
    expect(glo.requests).toHaveLength(1);
  });

  it('honours Retry-After on 429', async () => {
    glo.enqueue(
      { type: 'status', status: 429, headers: { 'Retry-After': '3' } },
      { type: 'body', body: latestBytes },
    );
    await client().getLatest();
    expect(clock.sleeps).toEqual([3000]);
  });

  it('gives up immediately when Retry-After exceeds the remaining budget', async () => {
    glo.enqueue({ type: 'status', status: 429, headers: { 'Retry-After': '3600' } });
    await expect(client().getLatest()).rejects.toThrow(GloRateLimitedError);
    expect(glo.requests).toHaveLength(1);
    expect(clock.sleeps).toEqual([]);
  });

  it('stops when the total budget would be exceeded', async () => {
    glo.enqueue({ type: 'status', status: 500 });
    const c = client({
      retry: { maxAttempts: 10, baseDelayMs: 1000, maxDelayMs: 100_000, totalBudgetMs: 2_000 },
    });
    await expect(c.getLatest()).rejects.toThrow(GloHttpError);
    // waits 500, 1000 → next (2000) would cross the 2 s budget
    expect(clock.sleeps).toEqual([500, 1000]);
    expect(glo.requests).toHaveLength(3);
  });
});

describe('timeouts and size limits (real sockets, small limits)', () => {
  it('times out a server that never answers', async () => {
    glo.enqueue({ type: 'hang' });
    const c = client({ timeoutMs: 150, retry: { maxAttempts: 1 } });
    await expect(c.getLatest()).rejects.toThrow(GloTimeoutError);
  });

  it('times out a response that drips slower than the deadline', async () => {
    glo.enqueue({ type: 'drip', body: latestBytes, chunkSize: 100, delayMs: 50 });
    const c = client({ timeoutMs: 200, retry: { maxAttempts: 1 } });
    await expect(c.getLatest()).rejects.toThrow(GloTimeoutError);
  });

  it('treats a body shorter than its Content-Length as a network error', async () => {
    glo.enqueue({
      type: 'truncate',
      body: latestBytes.subarray(0, 100),
      declaredLength: latestBytes.byteLength,
    });
    const c = client({ retry: { maxAttempts: 1 } });
    await expect(c.getLatest()).rejects.toThrow(GloNetworkError);
  });

  it('rejects an oversize declared Content-Length without reading the body', async () => {
    glo.enqueue({ type: 'oversize', bytes: 2_000_000, declareLength: true });
    await expect(client().getLatest()).rejects.toThrow(GloPayloadTooLargeError);
    expect(glo.requests).toHaveLength(1); // not retried
  });

  it('aborts a streamed body as soon as it passes the cap (no Content-Length)', async () => {
    glo.enqueue({ type: 'oversize', bytes: 3_000_000, declareLength: false });
    await expect(client().getLatest()).rejects.toThrow(GloPayloadTooLargeError);
  });

  it('accepts a body exactly at the cap and rejects one byte more', async () => {
    const cap = latestBytes.byteLength;
    glo.enqueue({ type: 'body', body: latestBytes });
    await expect(client({ maxResponseBytes: cap }).getLatest()).resolves.toBeTruthy();
    glo.enqueue({ type: 'body', body: latestBytes });
    await expect(client({ maxResponseBytes: cap - 1 }).getLatest()).rejects.toThrow(
      GloPayloadTooLargeError,
    );
  });

  it('maps connection refused to GloNetworkError', async () => {
    const url = glo.baseUrl;
    await glo.stop();
    const c = new GloClient(
      {
        baseUrl: url,
        minIntervalMs: 0,
        allowFastIntervalForLoopbackTests: true,
        retry: { maxAttempts: 1 },
      },
      { clock },
    );
    const err = (await c.getLatest().catch((e: unknown) => e)) as GloNetworkError;
    expect(err).toBeInstanceOf(GloNetworkError);
    expect(err.code).toBe('ECONNREFUSED');
    glo = await new FakeGlo().start(); // for afterEach
  });
});

describe('circuit breaker', () => {
  const c = () =>
    client({ retry: { maxAttempts: 1 }, circuit: { failureThreshold: 2, cooldownMs: 60_000 } });

  it('opens after consecutive upstream failures and blocks calls without network traffic', async () => {
    const cl = c();
    glo.enqueue({ type: 'status', status: 503 });
    await expect(cl.getLatest()).rejects.toThrow(GloHttpError);
    await expect(cl.getLatest()).rejects.toThrow(GloHttpError);
    expect(cl.circuitState).toBe('open');
    await expect(cl.getLatest()).rejects.toThrow(GloCircuitOpenError);
    expect(glo.requests).toHaveLength(2);

    clock.t += 60_000; // cooldown elapsed → one trial
    glo.enqueue({ type: 'body', body: latestBytes });
    await expect(cl.getLatest()).resolves.toBeTruthy();
    expect(cl.circuitState).toBe('closed');
  });

  it('schema errors and invalid requests do not open the circuit', async () => {
    const cl = c();
    glo.enqueue({ type: 'body', body: '<html>not json</html>' });
    for (let i = 0; i < 4; i++) await expect(cl.getLatest()).rejects.toThrow(GloSchemaError);
    for (let i = 0; i < 4; i++)
      await expect(cl.getResultByDate('bad')).rejects.toThrow(GloInvalidRequestError);
    expect(cl.circuitState).toBe('closed');
  });
});

describe('rate limiting through the client', () => {
  it('uses the 5 s default spacing between attempts (fake clock)', async () => {
    const cl = new GloClient({ baseUrl: glo.baseUrl }, { clock, random: () => 0 });
    glo.enqueue({ type: 'body', body: latestBytes });
    await cl.getLatest();
    await cl.getLatest();
    await cl.getLatest();
    expect(clock.sleeps).toEqual([5000, 5000]);
  });

  it('serialises concurrent calls through a custom transport (no parallel requests)', async () => {
    let inFlight = 0;
    let max = 0;
    const transport: HttpTransport = {
      async request() {
        inFlight++;
        max = Math.max(max, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        inFlight--;
        return { status: 200, headers: { 'content-type': 'application/json' }, body: latestBytes };
      },
    };
    const cl = new GloClient(
      { baseUrl: 'http://127.0.0.1:1', minIntervalMs: 0, allowFastIntervalForLoopbackTests: true },
      { transport, clock },
    );
    const outs = await Promise.all([
      cl.getLatest(),
      cl.getLatest(),
      cl.getLatest(),
      cl.getLatest(),
    ]);
    expect(outs).toHaveLength(4);
    expect(max).toBe(1);
  });
});
