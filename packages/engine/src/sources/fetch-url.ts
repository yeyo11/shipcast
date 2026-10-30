import { lookup } from 'node:dns/promises';
import http, { type ClientRequest, type IncomingMessage } from 'node:http';
import https from 'node:https';
import { connect as netConnect, isIP, type Socket } from 'node:net';
import { type Duplex, type Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import zlib from 'node:zlib';
import { ShipcastError } from '@shipcast/schema';
import { isPublicAddress } from './addresses.ts';

/** A page a source URL pointed to, as the fetcher read it */
export interface FetchedPage {
  /** The URL the page was finally read from, after every redirect */
  url: string;
  status: number;
  /** The mime type only, lower case: `text/html`, not `text/html; charset=utf-8` */
  contentType: string;
  /** The body decoded with its charset */
  text: string;
  /** The size of the body once its content encoding is undone, before the charset decodes it */
  bytes: number;
  /** Each URL a redirect led to, in order; the last one is `url` */
  redirects: string[];
}

export interface GuardedFetchOptions {
  /** Resolves a hostname; `dns.lookup` with every address in the resolver's order by default */
  resolve?: (hostname: string) => Promise<Array<{ address: string; family: 4 | 6 }>>;
  /** Whether a fetch may connect to an address; `isPublicAddress` by default */
  allowAddress?: (ip: string) => boolean;
  /** The most bytes of decoded body read; 2 MiB by default */
  maxBytes?: number;
  /** How long the whole fetch may take, every redirect and the body included; 15 s by default */
  timeoutMs?: number;
  /** How many redirects are followed; 5 by default */
  maxRedirects?: number;
  /** The mime types a page may have; HTML, plain text and Markdown by default */
  contentTypes?: readonly string[];
  /** The caller's own cancellation: its reason is what the fetch throws when it fires */
  signal?: AbortSignal;
}

export type UrlRefusal =
  | 'invalid'
  | 'scheme'
  | 'credentials'
  | 'address'
  | 'redirects'
  | 'size'
  | 'timeout'
  | 'content_type'
  | 'status'
  | 'network';

// The URL or what it serves is the problem (400 for the URL as written, 422 for where it leads or
// what it answers); the far end failing is a bad gateway, and only its own failures may pass later
const REFUSALS: Record<UrlRefusal, { httpStatus: number; retryable: boolean }> = {
  invalid: { httpStatus: 400, retryable: false },
  scheme: { httpStatus: 400, retryable: false },
  credentials: { httpStatus: 400, retryable: false },
  address: { httpStatus: 422, retryable: false },
  redirects: { httpStatus: 422, retryable: false },
  size: { httpStatus: 422, retryable: false },
  content_type: { httpStatus: 422, retryable: false },
  timeout: { httpStatus: 504, retryable: true },
  status: { httpStatus: 502, retryable: false },
  network: { httpStatus: 502, retryable: true },
};

/** Why a source URL was not read: the reason is the code */
export class UrlRefused extends ShipcastError {
  readonly reason: UrlRefusal;
  /** The status the page answered with, for a `status` refusal */
  readonly upstreamStatus: number | undefined;

  constructor(reason: UrlRefusal, message: string, options: { cause?: unknown; upstreamStatus?: number } = {}) {
    const { httpStatus, retryable } = REFUSALS[reason];
    // A page's own server error may be gone on the next try; its 404 will not
    const upstreamFailed = options.upstreamStatus !== undefined && options.upstreamStatus >= 500;
    super(message, { code: reason, httpStatus, retryable: retryable || upstreamFailed, cause: options.cause });
    this.name = 'UrlRefused';
    this.reason = reason;
    this.upstreamStatus = options.upstreamStatus;
  }
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_CONTENT_TYPES = ['text/html', 'application/xhtml+xml', 'text/plain', 'text/markdown'] as const;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

const HEADERS = {
  'user-agent': 'Shipcast (+https://github.com/yeyo11/shipcast)',
  accept: 'text/html,application/xhtml+xml,text/plain,text/markdown;q=0.9',
  'accept-encoding': 'gzip, deflate, br',
};

async function defaultResolve(hostname: string): Promise<Array<{ address: string; family: 4 | 6 }>> {
  const answers = await lookup(hostname, { all: true, order: 'verbatim' });
  return answers.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
}

interface Guard {
  resolve: NonNullable<GuardedFetchOptions['resolve']>;
  allowAddress: (ip: string) => boolean;
  signal: AbortSignal;
}

/** A URL a fetch may start from or be redirected to: http(s), and no credentials to hand over */
function checkUrl(url: URL): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UrlRefused('scheme', `only http and https URLs are read, not ${url.protocol}`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new UrlRefused('credentials', 'a URL with a user or password in it is not read');
  }
}

function parseUrl(text: string, base?: URL): URL {
  let url: URL;
  try {
    url = new URL(text, base);
  } catch {
    throw new UrlRefused('invalid', `not a URL: ${text}`);
  }
  checkUrl(url);
  return url;
}

/** The host as an address or a name to resolve: URLs bracket IPv6 literals */
function bareHost(url: URL): string {
  const host = url.hostname;
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

function waitFor(socket: Duplex, event: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      socket.off(event, onEvent);
      socket.off('error', onError);
      signal.removeEventListener('abort', onAbort);
    };
    const onEvent = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onAbort = (): void => {
      cleanup();
      socket.destroy();
      reject(signal.reason);
    };
    if (signal.aborted) return onAbort();
    socket.once(event, onEvent);
    socket.once('error', onError);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Opens the connection a request goes over, which is where the address is vetted: the hostname is
 * resolved once, every answer must be allowed (one private answer is enough to refuse: which one a
 * connection would use is not ours to predict), and the socket connects to a vetted address rather
 * than to the name, so a second resolution can never pick another one (DNS rebinding). The peer the
 * socket actually reached is checked again before http may write a byte to it.
 */
async function openConnection(hostname: string, port: number, secure: boolean, guard: Guard): Promise<Socket | TLSSocket> {
  const family = isIP(hostname);
  let addresses: Array<{ address: string; family: 4 | 6 }>;
  if (family === 4 || family === 6) {
    addresses = [{ address: hostname, family }];
  } else {
    try {
      addresses = await guard.resolve(hostname);
    } catch (error) {
      throw new UrlRefused('network', `${hostname} did not resolve`, { cause: error });
    }
    if (addresses.length === 0) throw new UrlRefused('network', `${hostname} did not resolve`);
  }
  const refused = addresses.find((a) => !guard.allowAddress(a.address));
  if (refused) throw new UrlRefused('address', `${hostname} leads to ${refused.address}, an address a source may not be read from`);
  guard.signal.throwIfAborted();

  let lastError: unknown;
  for (const { address, family: addressFamily } of addresses) {
    const socket = netConnect({ host: address, port, family: addressFamily });
    try {
      await waitFor(socket, 'connect', guard.signal);
    } catch (error) {
      socket.destroy();
      if (guard.signal.aborted) throw error;
      lastError = error;
      continue;
    }
    const peer = socket.remoteAddress;
    if (peer === undefined || !guard.allowAddress(peer)) {
      socket.destroy();
      throw new UrlRefused('address', `${hostname} connected to ${peer ?? 'an unknown address'}, an address a source may not be read from`);
    }
    if (!secure) return socket;
    // The certificate is checked against the name the URL gave, not against the address it resolved
    // to; SNI only takes names, so an IP literal goes without it and is checked as an IP
    const tlsSocket = tlsConnect({ socket, host: hostname, ...(isIP(hostname) === 0 && { servername: hostname }), ALPNProtocols: ['http/1.1'] });
    try {
      await waitFor(tlsSocket, 'secureConnect', guard.signal);
    } catch (error) {
      tlsSocket.destroy();
      throw error;
    }
    return tlsSocket;
  }
  throw new UrlRefused('network', `could not connect to ${hostname}`, { cause: lastError });
}

function send(url: URL, guard: Guard): Promise<{ request: ClientRequest; response: IncomingMessage }> {
  const secure = url.protocol === 'https:';
  const hostname = bareHost(url);
  const port = url.port === '' ? (secure ? 443 : 80) : Number(url.port);
  // Passed with no `agent`, not with `agent: false`: Node builds a fresh Agent for `false`, and an
  // Agent opens its sockets with its own createConnection (resolving the name itself), never the
  // request's. Only without an agent does ClientRequest call this one, and it waits on the callback.
  // No agent also means no keep-alive and no proxy from the environment
  const createConnection: NonNullable<http.RequestOptions['createConnection']> = (_options, done) => {
    openConnection(hostname, port, secure, guard).then(
      (socket) => done(null, socket),
      // On a failure Node reads only the error, which it emits on the request
      (error: unknown) => (done as (error: Error) => void)(error instanceof Error ? error : new Error(String(error))),
    );
    return undefined;
  };
  const options: https.RequestOptions = {
    method: 'GET',
    protocol: url.protocol,
    hostname,
    port,
    path: `${url.pathname}${url.search}`,
    headers: { ...HEADERS, host: url.host },
    createConnection,
    signal: guard.signal,
  };
  return new Promise((resolve, reject) => {
    const request = secure ? https.request(options) : http.request(options);
    request.once('response', (response) => resolve({ request, response }));
    // `on`, not `once`: a socket can fail again while the body is read, and an unheard error would crash the process
    request.on('error', reject);
    request.end();
  });
}

function contentTypeOf(header: string | undefined): { mime: string; charset: string | undefined } {
  if (!header) return { mime: '', charset: undefined };
  const [mime = '', ...params] = header.split(';');
  let charset: string | undefined;
  for (const param of params) {
    const [key = '', value = ''] = param.split('=');
    if (key.trim().toLowerCase() === 'charset') charset = value.trim().replace(/^["']|["']$/g, '');
  }
  return { mime: mime.trim().toLowerCase(), charset };
}

function decoders(encoding: string | undefined): Transform[] {
  if (!encoding) return [];
  // Several codings are listed in the order they were applied, so they are undone backwards
  const codings = encoding
    .split(',')
    .map((c) => c.trim().toLowerCase())
    .filter((c) => c !== '' && c !== 'identity')
    .reverse();
  return codings.map((coding) => {
    // A truncated stream decodes as far as it goes, as browsers read it
    const lenient = { finishFlush: zlib.constants.Z_SYNC_FLUSH };
    if (coding === 'gzip' || coding === 'x-gzip') return zlib.createGunzip(lenient);
    if (coding === 'deflate') return zlib.createInflate(lenient);
    if (coding === 'br') return zlib.createBrotliDecompress();
    throw new UrlRefused('content_type', `the page is encoded as ${coding}, which is not read`);
  });
}

/**
 * Reads the body up to the cap, counting the bytes once decompressed: a small gzip can inflate to
 * gigabytes, and zlib hands its output over in chunks, so the count stops it long before that
 */
async function readBody(response: IncomingMessage, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      total += chunk.length;
      if (total > maxBytes) return callback(new UrlRefused('size', `the page is larger than ${maxBytes} bytes`));
      chunks.push(chunk);
      callback();
    },
  });
  await pipeline([response, ...decoders(response.headers['content-encoding']), sink], { signal });
  return Buffer.concat(chunks, total);
}

function decodeText(body: Buffer, mime: string, charset: string | undefined): string {
  let label = charset;
  if (!label && (mime === 'text/html' || mime === 'application/xhtml+xml')) {
    const head = body.subarray(0, 1024).toString('latin1');
    label = /<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(head)?.[1];
  }
  try {
    return new TextDecoder(label ?? 'utf-8').decode(body);
  } catch {
    return new TextDecoder('utf-8').decode(body);
  }
}

/**
 * Reads a page a launch's source points to, from the server Shipcast runs on, which shares its
 * network with the database, Redis and other services: a URL must not be a way to reach them
 * (server-side request forgery). Every hop is checked as it is followed: the scheme, credentials,
 * every address its name resolves to and the address the connection reached; the size and the time
 * are capped over the whole fetch. Throws a `UrlRefused` with the reason, or the caller's abort reason.
 */
export async function fetchGuarded(url: string, options: GuardedFetchOptions = {}): Promise<FetchedPage> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const contentTypes: readonly string[] = options.contentTypes ?? DEFAULT_CONTENT_TYPES;
  options.signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const guard: Guard = { resolve: options.resolve ?? defaultResolve, allowAddress: options.allowAddress ?? isPublicAddress, signal };

  let current = parseUrl(url);
  const redirects: string[] = [];
  let request: ClientRequest | undefined;
  try {
    for (;;) {
      const sent = await send(current, guard);
      request = sent.request;
      const { response } = sent;
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      if (REDIRECTS.has(status) && location) {
        request.destroy();
        if (redirects.length >= maxRedirects) throw new UrlRefused('redirects', `the page redirects more than ${maxRedirects} times`);
        current = parseUrl(location, current);
        redirects.push(current.href);
        continue;
      }
      if (status < 200 || status > 299) {
        throw new UrlRefused('status', `the page answered ${status}`, { upstreamStatus: status });
      }
      const { mime, charset } = contentTypeOf(response.headers['content-type']);
      if (!contentTypes.includes(mime)) {
        throw new UrlRefused('content_type', mime === '' ? 'the page did not say what it is' : `the page is ${mime}, which is not read`);
      }
      const length = Number(response.headers['content-length']);
      if (Number.isFinite(length) && length > maxBytes) {
        throw new UrlRefused('size', `the page is ${length} bytes, more than ${maxBytes}`);
      }
      const body = await readBody(response, maxBytes, signal);
      return { url: current.href, status, contentType: mime, text: decodeText(body, mime, charset), bytes: body.length, redirects };
    }
  } catch (error) {
    if (error instanceof UrlRefused) throw error;
    if (options.signal?.aborted) throw options.signal.reason;
    if (timeout.aborted) throw new UrlRefused('timeout', `the page did not load within ${timeoutMs} ms`, { cause: error });
    const message = error instanceof Error ? error.message : String(error);
    throw new UrlRefused('network', `could not read ${current.href}: ${message}`, { cause: error });
  } finally {
    // Every way out, a refusal above all, drops the connection rather than leaving it to drain
    request?.destroy();
  }
}
