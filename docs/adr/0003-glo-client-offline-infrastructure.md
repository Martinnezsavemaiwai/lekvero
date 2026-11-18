# ADR-0003: Offline-only GLO client infrastructure (M4)

- Status: Accepted (approved by the project owner before M4)
- Date: 2026-11-16

## Context

Lekvero will eventually read results from the Government Lottery Office's documented public API (`docs/research/data-sources.md` §3). Before any live use, several things must be in place:
- GLO licensing must be clarified (`docs/legal/`);
- the owner must approve live access;
- ingestion (M5) needs a client whose behaviour is fully specified and tested.

The owner decided that **M4 makes no live GLO calls** and adds no live mode or smoke command.

## Decision

Create `packages/glo-client`, a client for the three documented endpoints (`getLatestLottery`, `getLotteryResult`, `getcheckLotteryResult`) that is **offline-only by construction**.

1. **Loopback-only guard, with no switch.**
   - `assertOfflineTarget()` refuses every host except `127.0.0.1`, `localhost` and `::1`. It also refuses non-HTTP(S) protocols and credentials in the URL.
   - It runs when the config is resolved **and again inside the transport** (defence in depth).
   - There is deliberately no environment variable or option that lifts it. Enabling live access requires a reviewed code change and a new ADR.
2. **Typed transport abstraction.** `HttpTransport.request()` returns status, lower-cased headers and exact body bytes. The default `NodeHttpTransport` uses `node:http`/`https` directly:
   - one deadline covering connect, headers and body;
   - the body is streamed and aborted as soon as it passes `maxResponseBytes`, and an oversize `Content-Length` is rejected before reading;
   - a body shorter than its declared length is a network error;
   - no redirects, no proxy, no cookies, and no connection reuse.
3. **Request policy.** These are the *design specification* for future live use; in M4 they are exercised only against the local mock server.

   | Setting | Default | Notes |
   |---|---|---|
   | Spacing | 1 request every 5 s, strictly serial (FIFO) | Floor of 2 s, which only a loopback-only test flag can bypass |
   | Timeout | 30 s per attempt | Configurable up to 120 s |
   | Response cap | 1 MiB | Same as the database. Cannot be raised |
   | Retries | Up to 5 attempts, full-jitter exponential backoff (2 s base, 60 s cap), 180 s total budget | Retried: network errors, timeouts, 5xx, 429 (respecting `Retry-After`). Not retried: other 4xx, oversize, schema problems, invalid requests |
   | Circuit breaker | Opens after 5 consecutive failed calls; 10-minute cooldown; then one trial call | Schema errors and invalid requests don't count, because GLO did answer |
4. **Safe errors.** The `GloClientError` subclasses are `offline_guard`, `invalid_request`, `network`, `timeout`, `http`, `rate_limited`, `payload_too_large`, `schema` and `circuit_open`, each with `retryable` and `countsAsUpstreamFailure` flags. A `GloSchemaError` carries the exact raw exchange, so ingestion can still store the bytes ("raw first").
5. **Schema validation through `@lekvero/shared`.** No second contract is introduced. On top of that, the client checks that:
   - the returned draw date equals the requested one;
   - checker verdicts cover exactly the requested numbers;
   - the draw maps to a known prize structure.

   Unknown upstream keys are reported (`unknownKeys`) as a drift signal. Results are **not** validated or verified here; that is ingestion's job (M5, the lifecycle in ADR-0002).
6. **Request validation happens before any I/O.** Dates must be ISO dates. Checker calls take 1–10 unique six-digit numbers, as GLO documents.
7. **Identification.** The default User-Agent is `Lekvero/0.0.0 (+https://github.com/Martinnezsavemaiwai/lekvero)`. It is the repository URL only, with no personal contact data. In M4 it is sent only to the mock server.
8. **Only allow-listed response headers are kept:** `date`, `content-type`, `content-length`, `cache-control`, `etag`, `last-modified`, `expires`, `age`, `x-cache`. Cookies, auth headers and WAF tokens are never kept.
9. **Deterministic tests.**
   - A local fake GLO server replays the archived fixtures byte for byte and simulates labelled synthetic failures: connection resets, hangs, slow drip-fed responses, truncated bodies, 4xx/5xx/429, oversize bodies, invalid JSON.
   - The clock and the random source are injected, so backoff, rate-limit and circuit-breaker timings are asserted exactly.
   - No test reaches any non-loopback host.

## Consequences

- **M5 can build on this unchanged.** It will provide the database wiring, scheduler and evidence workflow on top of this client, and will need a separate approval (and ADR) to enable live access.
- **Duplicated header allow-list.** The list also exists in `packages/db` (`raw-payload.ts`). Consolidating it into `@lekvero/shared` is a small follow-up, deferred so M4 doesn't modify M3 code.
- **No PDF downloads** (`api.glo.or.th`) and no proxy support. Both are deferred until live access is approved.
