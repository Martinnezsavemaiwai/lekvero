/** The three endpoints documented in GLO's data catalogue (dataset_c4-9_01). */
export type GloEndpoint = 'getLatestLottery' | 'getLotteryResult' | 'getcheckLotteryResult';

export const ENDPOINT_PATHS: Readonly<Record<GloEndpoint, string>> = Object.freeze({
  getLatestLottery: '/api/lottery/getLatestLottery',
  getLotteryResult: '/api/checking/getLotteryResult',
  getcheckLotteryResult: '/api/checking/getcheckLotteryResult',
});

/** What actually went over the wire, kept byte-exact for "raw first" storage. */
export interface RawExchange {
  readonly endpoint: GloEndpoint;
  readonly url: string;
  readonly method: 'POST';
  /** Parsed request body (for provenance); null when no body was sent. */
  readonly requestParams: Record<string, unknown> | null;
  readonly httpStatus: number;
  readonly fetchedAt: Date;
  /** Allow-listed, lower-cased response headers only (never cookies/auth). */
  readonly responseHeaders: Readonly<Record<string, string>>;
  readonly contentType: string | null;
  /** Exact response bytes. */
  readonly body: Buffer;
  /** Number of transport attempts made (≥1). */
  readonly attempts: number;
}

/** Injectable time source so retry/backoff/rate-limit tests are deterministic. */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
