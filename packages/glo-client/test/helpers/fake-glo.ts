/**
 * Local fake GLO server (loopback only) for offline tests.
 * Successful bodies are the ARCHIVED fixtures (fixtures/glo/v1), byte-for-byte.
 * Failure modes (resets, hangs, 5xx, 429, oversize, garbage) are SYNTHETIC.
 */
import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../fixtures/glo/v1',
);
export const fixture = (rel: string): Buffer => readFileSync(join(FIXTURE_ROOT, rel));

export type Scenario =
  | { type: 'body'; body: Buffer | string; status?: number; headers?: Record<string, string> }
  | { type: 'status'; status: number; headers?: Record<string, string>; body?: string }
  | { type: 'reset' }
  | { type: 'hang' }
  | { type: 'truncate'; body: Buffer; declaredLength: number }
  | { type: 'drip'; body: Buffer; chunkSize: number; delayMs: number }
  | { type: 'oversize'; bytes: number; declareLength: boolean };

export interface RecordedRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export class FakeGlo {
  readonly requests: RecordedRequest[] = [];
  private queue: Scenario[] = [];
  private fallback: Scenario = { type: 'status', status: 500, body: 'no scenario queued' };
  private server = http.createServer((req, res) => this.handle(req, res));
  private sockets = new Set<Socket>();

  /** Responses are served FIFO; the last one repeats when the queue empties. */
  enqueue(...scenarios: Scenario[]): this {
    this.queue.push(...scenarios);
    return this;
  }

  get baseUrl(): string {
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async start(): Promise<this> {
    this.server.on('connection', (s) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    return this;
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  private next(): Scenario {
    const s = this.queue.shift();
    if (s) this.fallback = s;
    return s ?? this.fallback;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      this.requests.push({
        method: req.method ?? '',
        path: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      const s = this.next();
      switch (s.type) {
        case 'body': {
          const body = Buffer.from(s.body);
          res.writeHead(s.status ?? 200, {
            'content-type': 'application/json; charset=utf-8',
            'content-length': body.byteLength,
            ...s.headers,
          });
          res.end(body);
          return;
        }
        case 'status':
          res.writeHead(s.status, s.headers);
          res.end(s.body ?? '');
          return;
        case 'reset':
          req.socket.destroy();
          return;
        case 'hang':
          return; // never answer
        case 'truncate':
          res.writeHead(200, {
            'content-type': 'application/json',
            'content-length': s.declaredLength,
          });
          res.write(s.body);
          setTimeout(() => req.socket.destroy(), 10);
          return;
        case 'drip': {
          res.writeHead(200, { 'content-type': 'application/json' });
          let i = 0;
          const tick = () => {
            if (res.destroyed) return;
            if (i >= s.body.byteLength) return void res.end();
            res.write(s.body.subarray(i, i + s.chunkSize));
            i += s.chunkSize;
            setTimeout(tick, s.delayMs);
          };
          tick();
          return;
        }
        case 'oversize': {
          const headers: Record<string, string | number> = { 'content-type': 'application/json' };
          if (s.declareLength) headers['content-length'] = s.bytes;
          res.writeHead(200, headers);
          const block = Buffer.alloc(64 * 1024, 0x20);
          let sent = 0;
          const pump = () => {
            while (sent < s.bytes && !res.destroyed) {
              const n = Math.min(block.byteLength, s.bytes - sent);
              sent += n;
              if (!res.write(block.subarray(0, n))) return void res.once('drain', pump);
            }
            if (!res.destroyed) res.end();
          };
          pump();
          return;
        }
      }
    });
  }
}

/** Deterministic clock: sleep() advances time instantly and records the requested waits. */
export class FakeClock {
  t = Date.parse('2026-11-16T09:00:00Z');
  readonly sleeps: number[] = [];
  now = () => this.t;
  sleep = async (ms: number) => {
    this.sleeps.push(ms);
    this.t += ms;
  };
}
