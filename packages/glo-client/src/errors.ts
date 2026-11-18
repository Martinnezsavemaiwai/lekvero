import type { RawExchange } from './types';

/**
 * Every failure the client can produce. `retryable` drives the retry policy;
 * `countsAsUpstreamFailure` drives the circuit breaker (schema problems mean
 * GLO answered, so they do not open the circuit).
 */
export type GloErrorKind =
  | 'offline_guard'
  | 'invalid_request'
  | 'network'
  | 'timeout'
  | 'http'
  | 'rate_limited'
  | 'payload_too_large'
  | 'schema'
  | 'circuit_open';

export class GloClientError extends Error {
  override readonly name: string = 'GloClientError';
  constructor(
    readonly kind: GloErrorKind,
    message: string,
    readonly retryable: boolean,
    readonly countsAsUpstreamFailure: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** The configured target is not allowed (M4: only loopback hosts). Never retried. */
export class GloOfflineGuardError extends GloClientError {
  override readonly name = 'GloOfflineGuardError';
  constructor(message: string) {
    super('offline_guard', message, false, false);
  }
}

/** Caller supplied invalid arguments (bad date, bad ticket numbers). Never sent. */
export class GloInvalidRequestError extends GloClientError {
  override readonly name = 'GloInvalidRequestError';
  constructor(message: string) {
    super('invalid_request', message, false, false);
  }
}

/** Connection refused/reset/DNS etc. */
export class GloNetworkError extends GloClientError {
  override readonly name = 'GloNetworkError';
  constructor(
    message: string,
    readonly code: string | undefined,
    options?: { cause?: unknown },
  ) {
    super('network', message, true, true, options);
  }
}

export class GloTimeoutError extends GloClientError {
  override readonly name = 'GloTimeoutError';
  constructor(readonly timeoutMs: number) {
    super('timeout', `No complete response within ${timeoutMs} ms`, true, true);
  }
}

/** Non-2xx response. 5xx is retryable; other 4xx are not. */
export class GloHttpError extends GloClientError {
  override readonly name = 'GloHttpError';
  constructor(readonly status: number) {
    super('http', `Unexpected HTTP status ${status}`, status >= 500, status >= 500);
  }
}

/** HTTP 429. Retryable, honouring Retry-After when present. */
export class GloRateLimitedError extends GloClientError {
  override readonly name = 'GloRateLimitedError';
  constructor(readonly retryAfterMs: number | null) {
    super('rate_limited', 'Upstream rate limit (HTTP 429)', true, true);
  }
}

export class GloPayloadTooLargeError extends GloClientError {
  override readonly name = 'GloPayloadTooLargeError';
  constructor(readonly limitBytes: number) {
    super('payload_too_large', `Response exceeded ${limitBytes} bytes`, false, true);
  }
}

/**
 * The response arrived but is not what the documented contract says
 * (invalid JSON, schema mismatch, wrong draw date, unknown prize structure).
 * Carries the exact raw exchange so ingestion can still store it ("raw first").
 */
export class GloSchemaError extends GloClientError {
  override readonly name = 'GloSchemaError';
  constructor(
    message: string,
    readonly raw: RawExchange,
    readonly issues: readonly string[] = [],
  ) {
    super('schema', message, false, false);
  }
}

export class GloCircuitOpenError extends GloClientError {
  override readonly name = 'GloCircuitOpenError';
  constructor(readonly retryAtMs: number) {
    super('circuit_open', 'Circuit breaker is open: upstream calls are paused', false, false);
  }
}
