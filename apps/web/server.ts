import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer as createHttp, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { extname, join, normalize, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { BlockList } from 'node:net';
import { onStop } from '@shipcast/runtime';
import { clientAddress } from './src/server/client-address.ts';
import { warm } from './src/server/warm.ts';

/**
 * The app in production: the built TanStack Start handler behind Node's own server, with the
 * certificate Shipcast obtains for the app's domain. No framework server: TLS, static files and
 * the request conversion are all this file does.
 */

const here = fileURLToPath(new URL('.', import.meta.url));
const clientDir = resolve(here, 'dist/client');

const TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

/** A file of the client build, never outside it; hashed assets are cached for a year */
function serveStatic(pathname: string, response: ServerResponse): boolean {
  const path = normalize(join(clientDir, decodeURIComponent(pathname)));
  if (!path.startsWith(clientDir) || !existsSync(path) || !statSync(path).isFile()) return false;
  response.writeHead(200, {
    'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
    'cache-control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
  });
  createReadStream(path).pipe(response);
  return true;
}

function toRequest(request: IncomingMessage, origin: string, proxies: BlockList | undefined, signal?: AbortSignal): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    else if (value !== undefined) headers.set(name, value);
  }
  // Who is calling, for the API's limit on wrong tokens: the socket, or behind a trusted proxy the
  // client it names; never what the client itself sent
  const forwarded = request.headers['x-forwarded-for'];
  headers.set('x-shipcast-peer', clientAddress(request.socket.remoteAddress, Array.isArray(forwarded) ? forwarded.join(',') : forwarded, proxies));
  const method = request.method ?? 'GET';
  const body = method === 'GET' || method === 'HEAD' ? undefined : (Readable.toWeb(request) as ReadableStream<Uint8Array>);
  return new Request(new URL(request.url ?? '/', origin), { method, headers, body, duplex: 'half', ...(signal && { signal }) } as RequestInit);
}

async function send(response: ServerResponse, answer: Response, plainHttp = false): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  answer.headers.forEach((value, name) => {
    if (name !== 'set-cookie') headers[name] = value;
  });
  // Over the preview's plain HTTP a browser drops a Secure cookie, so the session could not be kept there
  const cookies = answer.headers.getSetCookie().map((c) => (plainHttp ? c.replace(/;\s*Secure/gi, '') : c));
  if (cookies.length > 0) headers['set-cookie'] = cookies;
  response.writeHead(answer.status, headers);
  if (!answer.body) {
    response.end();
    return;
  }
  // A stream that never ends on its own (an event stream) is cancelled when the client goes
  const reader = answer.body.getReader();
  const gone = () => void reader.cancel().catch(() => undefined);
  response.once('close', gone);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      response.write(value);
    }
  } finally {
    response.off('close', gone);
  }
  response.end();
}

export interface ServeOptions {
  host: string;
  port: number;
  /** The public origin requests are rebuilt on, so URLs the app builds point where the browser is */
  origin: string;
  tls?: { key: string; cert: string };
  /** A preview copy over plain HTTP (`SHIPCAST_APP_TLS=off` in main.ts): cookies lose their Secure flag, which a browser refuses over HTTP on a tailnet address */
  plainHttp?: boolean;
  /** The proxies whose X-Forwarded-For names the client (SHIPCAST_TRUSTED_PROXIES); none, the socket is the client */
  trustedProxies?: BlockList;
  /**
   * A worker or heavy worker (SHIPCAST_ROLE): it answers /livez and /readyz for its orchestrator and
   * nothing else, so no page or API is ever served from a process that is not the web
   */
  healthOnly?: boolean;
  /** How long a stop waits for requests in flight (an SSE stream never ends on its own) before closing them */
  closeTimeoutMs?: number;
}

const HEALTH = new Set(['/livez', '/readyz']);
/** How long readiness waits for the warm-up (a few seconds when it works) before it stops holding the process back */
const WARM_TIMEOUT_MS = 60_000;

export async function serve(options: ServeOptions): Promise<{ close(): Promise<void>; setCertificate(tls: { key: string; cert: string }): void }> {
  const entry = (await import(join(here, 'dist/server/server.js'))) as { default: { fetch(request: Request): Promise<Response> } };
  let warmth: ReturnType<typeof warm> | undefined;
  const handler = async (request: IncomingMessage, response: ServerResponse) => {
    // Outside the try, so the catch can tell a client that left from a failure
    const left = new AbortController();
    try {
      const pathname = new URL(request.url ?? '/', 'http://x').pathname;
      // Not ready until the pages' chunks are loaded (see warm.ts): the proxy keeps visitors on a process that has them
      if (pathname === '/readyz' && warmth && !warmth.ready()) {
        response.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ ready: false, checks: { process: 'warming' } }));
        return;
      }
      if (options.healthOnly && !HEALTH.has(pathname)) {
        response.writeHead(404, { 'content-type': 'text/plain' });
        response.end('This process is a worker: only /livez and /readyz answer here.');
        return;
      }
      if ((request.method === 'GET' || request.method === 'HEAD') && pathname !== '/' && serveStatic(pathname, response)) return;
      // The request's signal aborts when the client goes, so a handler that waits on it (an event stream) lets go.
      // A response that already finished closes too: aborting then only throws into nobody (a healthcheck's fetch)
      response.once('close', () => {
        if (!response.writableFinished) left.abort();
      });
      await send(response, await entry.default.fetch(toRequest(request, options.origin, options.trustedProxies, left.signal)), options.plainHttp === true && !options.tls);
    } catch (error) {
      // A client closing an event stream aborts its request's signal, and the stream's read throws
      // that AbortError here: the client left, nothing went wrong. Any other error is still logged
      const clientLeft = left.signal.aborted && error instanceof Error && error.name === 'AbortError';
      if (!clientLeft) console.error(error);
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain' });
      response.end('Something went wrong; the details are in the app’s log.');
    }
  };
  const server = options.tls ? createHttps({ key: options.tls.key, cert: options.tls.cert }, handler) : createHttp(handler);
  await new Promise<void>((done) => server.listen(options.port, options.host, done));
  // The app's context, and with it the rounds nobody starts by hand, begins now rather than at the first visit
  void entry.default.fetch(new Request(`${options.origin}/api/health`)).catch(() => undefined);
  // A worker serves no page, so it has nothing to warm and is ready as soon as its checks are
  if (!options.healthOnly) warmth = warm(join(here, 'dist/server'), WARM_TIMEOUT_MS);
  /*
   * A stop's HTTP step (lifecycle.ts): no new connection is taken, idle keep-alive ones close now, and
   * the requests in flight get closeTimeoutMs to finish before their connections are cut
   */
  const close = () =>
    new Promise<void>((done) => {
      const cut = setTimeout(() => server.closeAllConnections(), options.closeTimeoutMs ?? 10_000);
      cut.unref();
      server.close(() => {
        clearTimeout(cut);
        done();
      });
      server.closeIdleConnections();
    });
  onStop('http', 'the HTTP server', close);
  return {
    close,
    // A renewed certificate is swapped in without dropping connections
    setCertificate: (tls) => {
      if ('setSecureContext' in server) server.setSecureContext({ key: tls.key, cert: tls.cert });
    },
  };
}
