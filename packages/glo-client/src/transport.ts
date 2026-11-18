import http from 'node:http';
import https from 'node:https';
import {
  GloNetworkError,
  GloOfflineGuardError,
  GloPayloadTooLargeError,
  GloTimeoutError,
} from './errors';
import { assertOfflineTarget } from './config';

export interface TransportRequest {
  readonly url: URL;
  readonly method: 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  /** Deadline for the COMPLETE response (headers and body). */
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
}

export interface TransportResponse {
  readonly status: number;
  /** Lower-cased header names; multi-value headers joined with ", ". */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Buffer;
}

/** Abstraction over the wire so tests (or a future live transport) can be swapped in. */
export interface HttpTransport {
  request(req: TransportRequest): Promise<TransportResponse>;
}

/**
 * node:http(s) transport.
 * - Streams the body and aborts as soon as it exceeds maxResponseBytes
 *   (also rejects early on an oversize Content-Length).
 * - One overall timer covers connect + headers + body.
 * - No redirects are followed; no proxy; no cookies are sent or kept.
 * - Defence in depth: refuses non-loopback URLs even if called directly (M4).
 */
export class NodeHttpTransport implements HttpTransport {
  request(req: TransportRequest): Promise<TransportResponse> {
    try {
      assertOfflineTarget(req.url.origin);
    } catch (err) {
      return Promise.reject(err); // keep the Promise contract: never throw synchronously
    }
    const lib = req.url.protocol === 'https:' ? https : http;

    return new Promise<TransportResponse>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      const clientReq = lib.request(req.url, {
        method: req.method,
        headers: { ...req.headers, 'content-length': String(req.body.byteLength) },
        agent: false, // no connection reuse: each attempt is independent and deterministic
      });

      const timer = setTimeout(() => {
        finish(() => reject(new GloTimeoutError(req.timeoutMs)));
        clientReq.destroy();
      }, req.timeoutMs);

      clientReq.on('response', (res) => {
        const declared = Number(res.headers['content-length']);
        if (Number.isFinite(declared) && declared > req.maxResponseBytes) {
          finish(() => reject(new GloPayloadTooLargeError(req.maxResponseBytes)));
          res.destroy();
          clientReq.destroy();
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > req.maxResponseBytes) {
            finish(() => reject(new GloPayloadTooLargeError(req.maxResponseBytes)));
            res.destroy();
            clientReq.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (!res.complete) {
            finish(() => reject(new GloNetworkError('Response ended prematurely', 'ECONNRESET')));
            return;
          }
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (v !== undefined) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
          }
          finish(() =>
            resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks, size) }),
          );
        });
        res.on('error', (err: NodeJS.ErrnoException) =>
          finish(() => reject(new GloNetworkError(err.message, err.code, { cause: err }))),
        );
        res.on('aborted', () =>
          finish(() => reject(new GloNetworkError('Response aborted', 'ECONNRESET'))),
        );
      });

      clientReq.on('error', (err: NodeJS.ErrnoException) => {
        if (err instanceof GloOfflineGuardError) {
          finish(() => reject(err));
          return;
        }
        finish(() => reject(new GloNetworkError(err.message, err.code, { cause: err })));
      });

      clientReq.end(Buffer.from(req.body));
    });
  }
}
