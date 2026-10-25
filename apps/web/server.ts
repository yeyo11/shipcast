import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer as createHttp, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { extname, join, normalize, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

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

function toRequest(request: IncomingMessage, origin: string): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    else if (value !== undefined) headers.set(name, value);
  }
  const method = request.method ?? 'GET';
  const body = method === 'GET' || method === 'HEAD' ? undefined : (Readable.toWeb(request) as ReadableStream<Uint8Array>);
  return new Request(new URL(request.url ?? '/', origin), { method, headers, body, duplex: 'half' } as RequestInit);
}

async function send(response: ServerResponse, answer: Response): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  answer.headers.forEach((value, name) => {
    if (name !== 'set-cookie') headers[name] = value;
  });
  const cookies = answer.headers.getSetCookie();
  if (cookies.length > 0) headers['set-cookie'] = cookies;
  response.writeHead(answer.status, headers);
  if (!answer.body) {
    response.end();
    return;
  }
  for await (const chunk of answer.body as unknown as AsyncIterable<Uint8Array>) response.write(chunk);
  response.end();
}

export interface ServeOptions {
  host: string;
  port: number;
  /** The public origin requests are rebuilt on, so URLs the app builds point where the browser is */
  origin: string;
  /**
   * Other origins the same app answers on (its address on the local network): a request whose Host is
   * one of them is rebuilt on it, so same-origin checks and cookies follow the address the browser used
   */
  aliases?: string[];
  tls?: { key: string; cert: string };
}

export async function serve(options: ServeOptions): Promise<{ close(): Promise<void>; setCertificate(tls: { key: string; cert: string }): void }> {
  const entry = (await import(join(here, 'dist/server/server.js'))) as { default: { fetch(request: Request): Promise<Response> } };
  const handler = async (request: IncomingMessage, response: ServerResponse) => {
    try {
      const pathname = new URL(request.url ?? '/', 'http://x').pathname;
      if ((request.method === 'GET' || request.method === 'HEAD') && pathname !== '/' && serveStatic(pathname, response)) return;
      const alias = options.aliases?.find((o) => new URL(o).host === request.headers.host);
      await send(response, await entry.default.fetch(toRequest(request, alias ?? options.origin)));
    } catch (error) {
      console.error(error);
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain' });
      response.end('Something went wrong; the details are in the app’s log.');
    }
  };
  const server = options.tls ? createHttps({ key: options.tls.key, cert: options.tls.cert }, handler) : createHttp(handler);
  await new Promise<void>((done) => server.listen(options.port, options.host, done));
  return {
    close: () => new Promise((done) => server.close(() => done())),
    // A renewed certificate is swapped in without dropping connections
    setCertificate: (tls) => {
      if ('setSecureContext' in server) server.setSecureContext({ key: tls.key, cert: tls.cert });
    },
  };
}
