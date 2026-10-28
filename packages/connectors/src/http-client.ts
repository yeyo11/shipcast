import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ConnectorError } from './http.ts';
import { quotaOf, type Quota } from './quota.ts';

/** What a provider said about its quota in one answer, for the counters */
export interface QuotaReport extends Quota {
  provider: string;
  url: string;
  status: number;
}

/** One attempt on the wire: the telemetry recorder plugs in here */
export interface HttpCall {
  method: string;
  url: string;
  /** 0 when no answer came (network error, timeout) */
  status: number;
  ms: number;
  /** 1 for the first try */
  attempt: number;
  /** A 304 answered from the ETag cache */
  fromCache: boolean;
}

/** A GET answer kept with its validator, so the next read can be a 304 */
export interface EtagEntry {
  etag: string;
  body: string;
  status: number;
  headers: Record<string, string>;
}

/** Async-capable so a Redis cache can stand behind it */
export interface EtagCache {
  get(key: string): EtagEntry | undefined | Promise<EtagEntry | undefined>;
  set(key: string, entry: EtagEntry): void | Promise<void>;
}

/** An ETag cache for one process and for tests: unbounded, so not for long-lived wide use */
export class MemoryEtagCache implements EtagCache {
  readonly entries = new Map<string, EtagEntry>();

  get(key: string): EtagEntry | undefined {
    return this.entries.get(key);
  }

  set(key: string, entry: EtagEntry): void {
    this.entries.set(key, entry);
  }
}

/**
 * An ETag cache for a long-lived process without Redis: least recently used first out, bounded by
 * entries and by the bytes of the bodies it holds, so reading many large files cannot grow it for
 * ever. A Map keeps insertion order, so re-inserting on every read is what makes it an LRU.
 */
export class LruEtagCache implements EtagCache {
  readonly #entries = new Map<string, EtagEntry>();
  readonly #maxEntries: number;
  readonly #maxBytes: number;
  #bytes = 0;

  constructor(options: { maxEntries?: number; maxBytes?: number } = {}) {
    this.#maxEntries = options.maxEntries ?? 1_000;
    this.#maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
  }

  get size(): number {
    return this.#entries.size;
  }

  get(key: string): EtagEntry | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry;
  }

  set(key: string, entry: EtagEntry): void {
    // An answer larger than a quarter of the cache would only push everything else out
    if (entry.body.length > this.#maxBytes / 4) return;
    this.#drop(key);
    this.#entries.set(key, entry);
    this.#bytes += entry.body.length;
    for (const oldest of this.#entries.keys()) {
      if (this.#entries.size <= this.#maxEntries && this.#bytes <= this.#maxBytes) break;
      this.#drop(oldest);
    }
  }

  #drop(key: string): void {
    const there = this.#entries.get(key);
    if (!there) return;
    this.#bytes -= there.body.length;
    this.#entries.delete(key);
  }
}

export interface RetryPolicy {
  /** Tries in all, the first included */
  attempts: number;
  /** The first backoff; each next one doubles */
  baseMs: number;
  /** No single wait is longer, Retry-After included */
  maxDelayMs: number;
  /** The waits of one call add up to no more: past it the last answer is returned as it is */
  maxTotalMs: number;
}

export interface HttpClientOptions {
  /** The network's name, used in errors and as the quota's provider */
  network: string;
  /** Resolved at call time when left out, so a process-wide wrapper installed later still sees every call */
  fetch?: typeof fetch;
  /** Relative URLs resolve against it */
  baseUrl?: string;
  /** Sent on every call; a call's own headers win */
  headers?: Record<string, string>;
  timeoutMs?: number;
  retry?: Partial<RetryPolicy>;
  etags?: EtagCache;
  onQuota?: (quota: QuotaReport) => void;
  onCall?: (call: HttpCall) => void;
  /** Injected for tests; must reject when the signal aborts */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

export interface RequestOptions extends Omit<RequestInit, 'method' | 'headers' | 'signal'> {
  method?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Sent as `Idempotency-Key`, and makes a non-idempotent call safe to retry */
  idempotencyKey?: string;
  /** Forces retries on (a POST the caller knows is safe) or off; the method decides when left out */
  retry?: boolean;
  /** Whether a GET uses the ETag cache, when the client has one; on by default */
  etagCache?: boolean;
  /** Names the call in errors ("publish", "read stats"); the method and path when left out */
  what?: string;
}

/** A Response that may have been rebuilt from the ETag cache */
export type HttpResponse = Response & { readonly fromCache: boolean };

const IDEMPOTENT = new Set(['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS']);
const RETRY_STATUSES = new Set([429, 502, 503, 504]);
const DEFAULT_RETRY: RetryPolicy = { attempts: 3, baseMs: 500, maxDelayMs: 30_000, maxTotalMs: 60_000 };

/** How long `Retry-After` asks to wait, in milliseconds: either seconds or an HTTP date */
export function retryAfterMs(headers: Headers, now: number = Date.now()): number | undefined {
  const value = headers.get('retry-after')?.trim();
  if (!value) return undefined;
  if (/^\d+(\.\d+)?$/.test(value)) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

/**
 * Frees the connection of an answer nobody reads. Not awaited: cancelling a body that was cloned
 * settles only once every copy is cancelled, which could stall the call forever.
 */
const discard = (response: Response): void => {
  response.body?.cancel().catch(() => undefined);
};

const flagged = (response: Response, fromCache: boolean): HttpResponse => Object.assign(response, { fromCache });

/** A transport failure, for the retry decision: the caller's own abort is never one */
class Transport {
  readonly error: unknown;
  readonly timedOut: boolean;

  constructor(error: unknown, timedOut: boolean) {
    this.error = error;
    this.timedOut = timedOut;
  }
}

/**
 * The one HTTP layer for connectors: a timeout on every call, retries that honour `Retry-After` on
 * requests safe to repeat, quota reporting, conditional GETs through an ETag cache, per-attempt
 * instrumentation, and non-2xx answers turned into ConnectorErrors.
 */
export class HttpClient {
  readonly network: string;
  readonly #options: HttpClientOptions;
  readonly #retry: RetryPolicy;
  readonly #timeoutMs: number;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly #now: () => number;
  readonly #random: () => number;

  constructor(options: HttpClientOptions) {
    this.network = options.network;
    this.#options = options;
    this.#retry = { ...DEFAULT_RETRY, ...options.retry };
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#sleep = options.sleep ?? ((ms, signal) => delay(ms, undefined, signal ? { signal } : {}));
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? Math.random;
  }

  /**
   * The answer after any retries, whatever its status. Throws a ConnectorError only when no answer
   * came (network error, timeout), and the caller's abort reason when the caller aborted.
   */
  async request(url: string | URL, options: RequestOptions = {}): Promise<HttpResponse> {
    const { method: given, headers: own, signal: caller, timeoutMs, idempotencyKey, retry, etagCache, what, ...init } = options;
    const method = (given ?? 'GET').toUpperCase();
    const href = this.#resolve(url);
    const headers = this.#headers(own, idempotencyKey);
    const retryable = retry ?? (IDEMPOTENT.has(method) || idempotencyKey !== undefined);
    const attempts = retryable ? Math.max(1, this.#retry.attempts) : 1;

    const etags = method === 'GET' && etagCache !== false ? this.#options.etags : undefined;
    const key = etags && this.#etagKey(href, headers);
    const cached = key !== undefined ? await etags?.get(key) : undefined;
    if (cached && headers['if-none-match'] === undefined) headers['if-none-match'] = cached.etag;

    let waited = 0;
    for (let attempt = 1; ; attempt++) {
      caller?.throwIfAborted();
      const started = this.#now();
      const outcome = await this.#attempt(href, { ...init, method, headers }, caller, timeoutMs ?? this.#timeoutMs);
      const ms = this.#now() - started;
      const last = attempt >= attempts;

      if (outcome instanceof Transport) {
        this.#options.onCall?.({ method, url: href, status: 0, ms, attempt, fromCache: false });
        const wait = this.#backoff(attempt);
        if (last || waited + wait > this.#retry.maxTotalMs) throw this.#transportError(method, href, outcome, timeoutMs ?? this.#timeoutMs, retryable, what);
        waited += wait;
        await this.#sleep(wait, caller);
        continue;
      }

      const response = outcome;
      this.#reportQuota(href, response);
      const fromCache = response.status === 304 && cached !== undefined;
      this.#options.onCall?.({ method, url: href, status: response.status, ms, attempt, fromCache });

      if (RETRY_STATUSES.has(response.status) && !last) {
        const asked = retryAfterMs(response.headers, this.#now());
        const wait = Math.min(this.#retry.maxDelayMs, asked ?? this.#backoff(attempt));
        // A Retry-After past the cap means the provider will refuse sooner retries too
        if ((asked === undefined || asked <= this.#retry.maxDelayMs) && waited + wait <= this.#retry.maxTotalMs) {
          discard(response);
          waited += wait;
          await this.#sleep(wait, caller);
          continue;
        }
      }

      if (fromCache) return flagged(new Response(cached.body, { status: cached.status, headers: cached.headers }), true);
      if (key !== undefined && etags && response.ok) {
        const etag = response.headers.get('etag');
        if (etag) await etags.set(key, { etag, body: await response.clone().text(), status: response.status, headers: Object.fromEntries(response.headers) });
      }
      return flagged(response, false);
    }
  }

  /** A JSON answer, the way the `json()` helper reads one */
  async json<T>(url: string | URL, options: RequestOptions = {}): Promise<T> {
    const response = await this.request(url, options);
    const text = await this.#body(url, response, options);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ConnectorError(this.network, `${this.#what(url, options)}: the answer is not JSON`, response.status);
    }
  }

  async text(url: string | URL, options: RequestOptions = {}): Promise<string> {
    return this.#body(url, await this.request(url, options), options);
  }

  /** For an answer whose body does not matter (a 204, a delete) */
  async ok(url: string | URL, options: RequestOptions = {}): Promise<void> {
    const response = await this.request(url, options);
    if (response.ok) {
      discard(response);
      return;
    }
    await this.#body(url, response, options);
  }

  async #body(url: string | URL, response: Response, options: RequestOptions): Promise<string> {
    const text = await response.text().catch(() => '');
    if (!response.ok) throw new ConnectorError(this.network, `${this.#what(url, options)}: ${response.status} ${text.slice(0, 300)}`, response.status);
    return text;
  }

  async #attempt(url: string, init: RequestInit, caller: AbortSignal | undefined, timeoutMs: number): Promise<Response | Transport> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = caller ? AbortSignal.any([caller, timeout]) : timeout;
    // Read at call time: the telemetry wrapper replaces globalThis.fetch after clients may exist
    const fetcher = this.#options.fetch ?? globalThis.fetch;
    try {
      return await fetcher(url, { ...init, signal });
    } catch (error) {
      if (caller?.aborted) throw caller.reason;
      return new Transport(error, timeout.aborted);
    }
  }

  #transportError(method: string, url: string, failure: Transport, timeoutMs: number, retryable: boolean, what: string | undefined): ConnectorError {
    const label = what ?? `${method} ${new URL(url).pathname}`;
    const reason = failure.timedOut ? `timed out after ${timeoutMs} ms` : `could not reach the network: ${failure.error instanceof Error ? failure.error.message : String(failure.error)}`;
    // A POST that timed out may have gone through: trying it again could publish twice
    const error = new ConnectorError(this.network, `${label}: ${reason}`, undefined, retryable);
    error.cause = failure.error;
    return error;
  }

  /** Exponential with equal jitter: never zero, never in lockstep with another client */
  #backoff(attempt: number): number {
    const ceiling = Math.min(this.#retry.maxDelayMs, this.#retry.baseMs * 2 ** (attempt - 1));
    return ceiling / 2 + this.#random() * (ceiling / 2);
  }

  #reportQuota(url: string, response: Response): void {
    if (!this.#options.onQuota) return;
    const quota = quotaOf(response.headers, this.#now());
    if (quota) this.#options.onQuota({ ...quota, provider: this.network, url, status: response.status });
  }

  #resolve(url: string | URL): string {
    return (this.#options.baseUrl ? new URL(url, this.#options.baseUrl) : new URL(url)).href;
  }

  /** Lower-cased into a plain object, which is what the connectors' test fakes read */
  #headers(own: Record<string, string> | undefined, idempotencyKey: string | undefined): Record<string, string> {
    const merged = new Headers(this.#options.headers);
    for (const [name, value] of Object.entries(own ?? {})) merged.set(name, value);
    if (idempotencyKey !== undefined) merged.set('idempotency-key', idempotencyKey);
    return Object.fromEntries(merged);
  }

  /** The credential is part of the key: two accounts reading one URL must never share an answer */
  #etagKey(url: string, headers: Record<string, string>): string {
    const credential = headers.authorization ?? headers.cookie;
    const who = credential ? `#${createHash('sha256').update(credential).digest('hex').slice(0, 16)}` : '';
    return `${this.network} ${url}${who}`;
  }

  #what(url: string | URL, options: RequestOptions): string {
    return options.what ?? `${(options.method ?? 'GET').toUpperCase()} ${new URL(this.#resolve(url)).pathname}`;
  }
}
