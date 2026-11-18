import { z } from 'zod';
import { GloOfflineGuardError } from './errors';

/**
 * Conservative request policy — a DESIGN SPECIFICATION for future live use.
 * In M4 the client can only reach loopback hosts (see assertOfflineTarget),
 * so these values are exercised exclusively against the local mock server.
 */
export const DEFAULT_POLICY = Object.freeze({
  /** At most one request every 5 s, strictly serial. */
  minIntervalMs: 5_000,
  /** Hard floor: configuration can never make the client faster than this. */
  minIntervalFloorMs: 2_000,
  /** Per-attempt deadline for a complete response. */
  timeoutMs: 30_000,
  /** Same cap as the database (raw_payload ≤ 1 MiB). */
  maxResponseBytes: 1_048_576,
  retry: Object.freeze({
    maxAttempts: 5,
    baseDelayMs: 2_000,
    maxDelayMs: 60_000,
    /** Overall budget across all attempts and waits for one logical call. */
    totalBudgetMs: 180_000,
  }),
  circuit: Object.freeze({
    /** Consecutive failed logical calls before pausing upstream access. */
    failureThreshold: 5,
    cooldownMs: 600_000,
  }),
});

/** Project identification for documentation; the M4 client sends it only to the mock server. */
export const PROJECT_URL = 'https://github.com/Martinnezsavemaiwai/lekvero';
export const DEFAULT_USER_AGENT = `Lekvero/0.0.0 (+${PROJECT_URL})`;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * M4 is offline-only: the client refuses every non-loopback target. There is
 * deliberately NO configuration flag to lift this; enabling live access needs a
 * reviewed code change (ADR-0003).
 */
export function assertOfflineTarget(baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new GloOfflineGuardError(`Invalid base URL: ${JSON.stringify(baseUrl)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new GloOfflineGuardError(`Unsupported protocol ${url.protocol}`);
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new GloOfflineGuardError(
      `Live GLO access is not enabled in this build (M4 is offline-only); refusing host ${url.hostname}.`,
    );
  }
  if (url.username || url.password) {
    throw new GloOfflineGuardError('Credentials in the base URL are not allowed.');
  }
  return url;
}

const ConfigSchema = z.object({
  baseUrl: z.string(),
  userAgent: z.string().min(1).max(200).default(DEFAULT_USER_AGENT),
  minIntervalMs: z.number().int().min(0).default(DEFAULT_POLICY.minIntervalMs),
  timeoutMs: z.number().int().positive().max(120_000).default(DEFAULT_POLICY.timeoutMs),
  maxResponseBytes: z
    .number()
    .int()
    .positive()
    .max(DEFAULT_POLICY.maxResponseBytes)
    .default(DEFAULT_POLICY.maxResponseBytes),
  retry: z
    .object({
      maxAttempts: z.number().int().min(1).max(10).default(DEFAULT_POLICY.retry.maxAttempts),
      baseDelayMs: z.number().int().min(0).default(DEFAULT_POLICY.retry.baseDelayMs),
      maxDelayMs: z.number().int().min(0).default(DEFAULT_POLICY.retry.maxDelayMs),
      totalBudgetMs: z.number().int().positive().default(DEFAULT_POLICY.retry.totalBudgetMs),
    })
    .default({ ...DEFAULT_POLICY.retry }),
  circuit: z
    .object({
      failureThreshold: z.number().int().min(1).default(DEFAULT_POLICY.circuit.failureThreshold),
      cooldownMs: z.number().int().min(0).default(DEFAULT_POLICY.circuit.cooldownMs),
    })
    .default({ ...DEFAULT_POLICY.circuit }),
  /**
   * Test-only escape hatch for the interval floor, honoured only together with a
   * loopback target (which M4 always enforces anyway). Lets tests run quickly.
   */
  allowFastIntervalForLoopbackTests: z.boolean().default(false),
});

export type GloClientConfigInput = z.input<typeof ConfigSchema>;
export type GloClientConfig = z.output<typeof ConfigSchema> & { readonly origin: URL };

export function resolveConfig(input: GloClientConfigInput): GloClientConfig {
  const parsed = ConfigSchema.parse(input);
  const origin = assertOfflineTarget(parsed.baseUrl);
  const floor = parsed.allowFastIntervalForLoopbackTests ? 0 : DEFAULT_POLICY.minIntervalFloorMs;
  return {
    ...parsed,
    minIntervalMs: Math.max(parsed.minIntervalMs, floor),
    origin,
  };
}
