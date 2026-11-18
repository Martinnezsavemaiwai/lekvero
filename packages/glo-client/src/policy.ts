import { GloCircuitOpenError } from './errors';
import type { Clock } from './types';

/**
 * Full-jitter exponential backoff: random ∈ [0,1) × min(maxDelay, base × 2^(attempt-1)).
 * `attempt` is the number of the attempt that just failed (1-based).
 */
export function backoffDelayMs(
  attempt: number,
  random: number,
  baseDelayMs: number,
  maxDelayMs: number,
): number {
  const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  return Math.floor(Math.min(Math.max(random, 0), 0.999999) * ceiling);
}

/**
 * Parse Retry-After (delta-seconds or HTTP-date) into milliseconds from `nowMs`.
 * Returns null when absent or unparseable; never negative.
 */
export function parseRetryAfterMs(value: string | undefined, nowMs: number): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - nowMs);
}

/**
 * Strictly serial gate with a minimum spacing between request STARTS.
 * Callers are queued FIFO; at most one request is in flight.
 */
export class RateLimiter {
  private tail: Promise<void> = Promise.resolve();
  private lastStart: number | null = null;

  constructor(
    private readonly minIntervalMs: number,
    private readonly clock: Clock,
  ) {}

  /** Run `fn` when it is this caller's turn and the interval has elapsed. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const turn = this.tail.then(async () => {
      if (this.lastStart !== null) {
        const wait = this.lastStart + this.minIntervalMs - this.clock.now();
        if (wait > 0) await this.clock.sleep(wait);
      }
      this.lastStart = this.clock.now();
      return fn();
    });
    // Keep the chain alive regardless of this caller's outcome.
    this.tail = turn.then(
      () => undefined,
      () => undefined,
    );
    return turn;
  }
}

export type CircuitState = 'closed' | 'open' | 'half_open';

/**
 * Counts consecutive failed LOGICAL calls (after retries). Opens at the
 * threshold; after the cooldown allows a single trial call (half-open).
 */
export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;
  private trialInFlight = false;

  constructor(
    private readonly failureThreshold: number,
    private readonly cooldownMs: number,
    private readonly clock: Clock,
  ) {}

  get state(): CircuitState {
    if (this.openedAt === null) return 'closed';
    return this.clock.now() - this.openedAt >= this.cooldownMs ? 'half_open' : 'open';
  }

  /** Throws GloCircuitOpenError when calls are paused. */
  beforeCall(): void {
    const s = this.state;
    if (s === 'open' || (s === 'half_open' && this.trialInFlight)) {
      throw new GloCircuitOpenError((this.openedAt ?? 0) + this.cooldownMs);
    }
    if (s === 'half_open') this.trialInFlight = true;
  }

  onSuccess(): void {
    this.failures = 0;
    this.openedAt = null;
    this.trialInFlight = false;
  }

  onFailure(): void {
    this.trialInFlight = false;
    this.failures++;
    if (this.openedAt !== null || this.failures >= this.failureThreshold) {
      this.openedAt = this.clock.now(); // (re)open, restarting the cooldown
    }
  }

  /** A call that ended without an upstream verdict (e.g. schema error) releases a trial slot. */
  onNeutral(): void {
    if (this.state === 'half_open') this.onSuccess();
    this.trialInFlight = false;
  }
}
