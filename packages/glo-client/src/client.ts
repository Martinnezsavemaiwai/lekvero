import { z } from 'zod';
import {
  GloByDateEnvelopeSchema,
  GloCheckEnvelopeSchema,
  GloLatestEnvelopeSchema,
  TicketNumberSchema,
  mapGloDraw,
  unknownDrawKeys,
} from '@lekvero/shared';
import type { DrawResult, GloCheckEnvelope, GloDraw } from '@lekvero/shared';
import { resolveConfig } from './config';
import type { GloClientConfig, GloClientConfigInput } from './config';
import {
  GloClientError,
  GloHttpError,
  GloInvalidRequestError,
  GloRateLimitedError,
  GloSchemaError,
} from './errors';
import { CircuitBreaker, RateLimiter, backoffDelayMs, parseRetryAfterMs } from './policy';
import { NodeHttpTransport } from './transport';
import type { HttpTransport } from './transport';
import { ENDPOINT_PATHS, systemClock } from './types';
import type { Clock, GloEndpoint, RawExchange } from './types';

/** Response headers kept for provenance; everything else (cookies, auth, WAF tokens) is dropped. */
export const ALLOWED_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  'date',
  'content-type',
  'content-length',
  'cache-control',
  'etag',
  'last-modified',
  'expires',
  'age',
  'x-cache',
]);

/** GLO documents at most 10 numbers per checker call. */
export const MAX_CHECK_NUMBERS = 10;

export interface DrawOutcome {
  readonly kind: 'draw';
  readonly raw: RawExchange;
  /** Schema-validated GLO draw object (unknown extra keys preserved). */
  readonly gloDraw: GloDraw;
  /** Canonical draw. NOT validated or verified: that is ingestion's job (M5). */
  readonly draw: DrawResult;
  /** Keys GLO sent that the contract does not know (schema-drift signal). */
  readonly unknownKeys: readonly string[];
}

export interface NotPublishedOutcome {
  readonly kind: 'not_published';
  readonly raw: RawExchange;
}

export interface CheckOutcome {
  readonly kind: 'check';
  readonly raw: RawExchange;
  readonly envelope: GloCheckEnvelope;
}

export interface GloClientDeps {
  readonly transport?: HttpTransport;
  readonly clock?: Clock;
  /** Returns a number in [0, 1). Injected for deterministic backoff tests. */
  readonly random?: () => number;
}

const IsoDate = z.iso.date();

/**
 * Offline-only client for GLO's three documented endpoints (M4).
 * Every call: circuit breaker → serial rate limiter → transport (timeout, size
 * cap) → retry with full-jitter backoff within a total budget → schema
 * validation. Results always carry the exact raw exchange.
 */
export class GloClient {
  readonly config: GloClientConfig;
  private readonly transport: HttpTransport;
  private readonly clock: Clock;
  private readonly random: () => number;
  private readonly limiter: RateLimiter;
  private readonly breaker: CircuitBreaker;

  constructor(config: GloClientConfigInput, deps: GloClientDeps = {}) {
    this.config = resolveConfig(config);
    this.transport = deps.transport ?? new NodeHttpTransport();
    this.clock = deps.clock ?? systemClock;
    this.random = deps.random ?? Math.random;
    this.limiter = new RateLimiter(this.config.minIntervalMs, this.clock);
    this.breaker = new CircuitBreaker(
      this.config.circuit.failureThreshold,
      this.config.circuit.cooldownMs,
      this.clock,
    );
  }

  get circuitState() {
    return this.breaker.state;
  }

  /** POST getLatestLottery (no request body, as documented). */
  async getLatest(): Promise<DrawOutcome> {
    const raw = await this.send('getLatestLottery', null);
    const env = this.parseJson(raw, GloLatestEnvelopeSchema);
    return this.toDrawOutcome(raw, env.response as GloDraw & Record<string, unknown>);
  }

  /** POST getLotteryResult for a Gregorian YYYY-MM-DD draw date. */
  async getResultByDate(date: string): Promise<DrawOutcome | NotPublishedOutcome> {
    const d = IsoDate.safeParse(date);
    if (!d.success) throw new GloInvalidRequestError(`Invalid draw date ${JSON.stringify(date)}`);
    const [year, month, day] = date.split('-') as [string, string, string];
    const raw = await this.send('getLotteryResult', { date: day, month, year });
    const env = this.parseJson(raw, GloByDateEnvelopeSchema);
    // null = GLO has no data for that date; NOT proof that no draw happened.
    if (env.response === null) return { kind: 'not_published', raw };
    const out = this.toDrawOutcome(raw, env.response.result as GloDraw & Record<string, unknown>);
    if (out.draw.drawDate !== date) {
      throw new GloSchemaError(
        `Requested ${date} but GLO returned draw ${out.draw.drawDate}`,
        raw,
        ['date_mismatch'],
      );
    }
    return out;
  }

  /** POST getcheckLotteryResult: GLO's own verdicts for up to 10 six-digit numbers. */
  async checkNumbers(date: string, numbers: readonly string[]): Promise<CheckOutcome> {
    if (!IsoDate.safeParse(date).success) {
      throw new GloInvalidRequestError(`Invalid draw date ${JSON.stringify(date)}`);
    }
    if (numbers.length === 0 || numbers.length > MAX_CHECK_NUMBERS) {
      throw new GloInvalidRequestError(
        `Provide 1–${MAX_CHECK_NUMBERS} numbers (got ${numbers.length})`,
      );
    }
    for (const n of numbers) {
      if (!TicketNumberSchema.safeParse(n).success) {
        throw new GloInvalidRequestError(`Invalid ticket number ${JSON.stringify(n)}`);
      }
    }
    if (new Set(numbers).size !== numbers.length) {
      throw new GloInvalidRequestError('Duplicate ticket numbers');
    }
    const raw = await this.send('getcheckLotteryResult', {
      number: numbers.map((n) => ({ lottery_num: n })),
      period_date: date,
    });
    const envelope = this.parseJson(raw, GloCheckEnvelopeSchema);
    const returned = envelope.response.result.map((r) => r.number).sort();
    if (returned.join(',') !== [...numbers].sort().join(',')) {
      throw new GloSchemaError('Checker verdicts do not match the requested numbers', raw, [
        'number_mismatch',
      ]);
    }
    return { kind: 'check', raw, envelope };
  }

  // ---------------------------------------------------------------------------

  private toDrawOutcome(raw: RawExchange, gloDraw: GloDraw & Record<string, unknown>): DrawOutcome {
    try {
      return {
        kind: 'draw',
        raw,
        gloDraw,
        draw: mapGloDraw(gloDraw),
        unknownKeys: unknownDrawKeys(gloDraw),
      };
    } catch (err) {
      throw new GloSchemaError(`Cannot map draw: ${(err as Error).message}`, raw, ['unmappable']);
    }
  }

  private parseJson<T>(raw: RawExchange, schema: z.ZodType<T>): T {
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw.body));
    } catch {
      throw new GloSchemaError('Response body is not valid UTF-8 JSON', raw, ['invalid_json']);
    }
    const result = schema.safeParse(json);
    if (!result.success) {
      throw new GloSchemaError(
        'Response does not match the documented GLO contract',
        raw,
        result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
      );
    }
    return result.data;
  }

  /**
   * One logical call: breaker → (rate-limited attempt → retry?)* within budget.
   * Schema problems are decided by the caller after this returns 2xx bytes.
   */
  private async send(
    endpoint: GloEndpoint,
    params: Record<string, unknown> | null,
  ): Promise<RawExchange> {
    this.breaker.beforeCall();
    const url = new URL(ENDPOINT_PATHS[endpoint], this.config.origin);
    const body =
      params === null ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(params));
    const { retry } = this.config;
    const deadline = this.clock.now() + retry.totalBudgetMs;

    for (let attempt = 1; ; attempt++) {
      try {
        const res = await this.limiter.run(() =>
          this.transport.request({
            url,
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              accept: 'application/json',
              'user-agent': this.config.userAgent,
            },
            body,
            timeoutMs: Math.min(this.config.timeoutMs, Math.max(1, deadline - this.clock.now())),
            maxResponseBytes: this.config.maxResponseBytes,
          }),
        );
        if (res.status === 429) {
          throw new GloRateLimitedError(
            parseRetryAfterMs(res.headers['retry-after'], this.clock.now()),
          );
        }
        if (res.status < 200 || res.status > 299) throw new GloHttpError(res.status);

        const responseHeaders: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (ALLOWED_RESPONSE_HEADERS.has(k)) responseHeaders[k] = v;
        }
        this.breaker.onSuccess();
        return {
          endpoint,
          url: url.toString(),
          method: 'POST',
          requestParams: params,
          httpStatus: res.status,
          fetchedAt: new Date(this.clock.now()),
          responseHeaders,
          contentType: res.headers['content-type'] ?? null,
          body: res.body,
          attempts: attempt,
        };
      } catch (err) {
        const e = err instanceof GloClientError ? err : undefined;
        if (!e || !e.retryable || attempt >= retry.maxAttempts) {
          this.recordFailure(e);
          throw err;
        }
        const backoff = backoffDelayMs(attempt, this.random(), retry.baseDelayMs, retry.maxDelayMs);
        const wait =
          e instanceof GloRateLimitedError && e.retryAfterMs !== null
            ? Math.max(backoff, e.retryAfterMs)
            : backoff;
        if (this.clock.now() + wait >= deadline) {
          this.recordFailure(e);
          throw err;
        }
        await this.clock.sleep(wait);
      }
    }
  }

  private recordFailure(e: GloClientError | undefined): void {
    if (!e || e.countsAsUpstreamFailure) this.breaker.onFailure();
    else this.breaker.onNeutral();
  }
}
