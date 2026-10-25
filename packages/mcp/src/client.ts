/*
 * A small client of Shipcast's REST API (/api/v1, docs/api.md). Every tool goes through it, so the MCP
 * server and WebMCP get the API's own checks (scopes, validation, a launch happening once) instead of
 * a second set. It uses nothing but fetch, so the browser can run it too.
 */

/**
 * The header WebMCP's same-origin calls carry. A page on another site cannot add a custom header to a
 * request without a CORS preflight the app never answers, so the API can trust the session cookie on
 * a request that has it (and Sec-Fetch-Site: same-origin) without opening itself to forged requests.
 */
export const WEBMCP_HEADER = 'x-shipcast-webmcp';

export type Method ='GET' | 'POST' | 'PATCH' | 'DELETE';

/** What the API answers on an error, plus the two failures that never reach it */
export type ApiErrorCode =
  | 'unauthorized'
  | 'insufficient_scope'
  | 'rate_limited'
  | 'not_found'
  | 'method_not_allowed'
  | 'invalid_input'
  | 'unsupported_media_type'
  | 'refused'
  | 'upstream'
  | 'internal'
  | 'unreachable'
  | 'bad_response';

export class ShipcastApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  /** Seconds to wait, from Retry-After on a 429 */
  readonly retryAfter: number | undefined;

  constructor(status: number, code: ApiErrorCode, message: string, retryAfter?: number) {
    super(message);
    this.name = 'ShipcastApiError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
  /** The app's origin, `https://host`; empty for same-origin calls from the app's own pages */
  baseUrl: string;
  /** A bearer token with the `read` and `write` scopes; left out in the browser, where the session is used */
  token?: string;
  /** Extra headers on every call: WebMCP's marker header, or the client's address under /mcp */
  headers?: Record<string, string>;
  credentials?: RequestInit['credentials'];
  fetch?: FetchLike;
}

export interface CallOptions {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
}

export interface ShipcastApi {
  call<T = unknown>(method: Method, path: string, options?: CallOptions): Promise<T>;
}

const CODES = new Set<string>(['unauthorized', 'insufficient_scope', 'rate_limited', 'not_found', 'method_not_allowed', 'invalid_input', 'unsupported_media_type', 'refused', 'upstream', 'internal']);

/** A status without the API's error body (a proxy's page, an older app) still gets a code */
function codeFor(status: number): ApiErrorCode {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'insufficient_scope';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status === 400) return 'invalid_input';
  if (status === 409) return 'refused';
  return status >= 500 ? 'internal' : 'bad_response';
}

/** Takes the token out of anything that will be shown, in case a proxy or a server ever echoes it back */
export function redact(text: string, token: string | undefined): string {
  return token ? text.split(token).join('[token]') : text;
}

export function createApiClient(options: ApiClientOptions): ShipcastApi {
  const base = options.baseUrl.replace(/\/+$/, '');
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  return {
    async call<T>(method: Method, path: string, call: CallOptions = {}): Promise<T> {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(call.query ?? {})) if (value !== undefined) query.set(key, String(value));
      const url = `${base}/api/v1${path}${query.size > 0 ? `?${query}` : ''}`;
      const headers: Record<string, string> = { accept: 'application/json', ...options.headers };
      if (options.token) headers.authorization = `Bearer ${options.token}`;
      if (call.body !== undefined) headers['content-type'] = 'application/json';
      let response: Response;
      try {
        response = await doFetch(url, {
          method,
          headers,
          ...(call.body !== undefined && { body: JSON.stringify(call.body) }),
          ...(options.credentials && { credentials: options.credentials }),
        });
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        throw new ShipcastApiError(0, 'unreachable', redact(`could not reach Shipcast at ${base || 'this origin'}: ${why}`, options.token));
      }
      const text = await response.text();
      let body: unknown;
      try {
        body = text === '' ? undefined : (JSON.parse(text) as unknown);
      } catch {
        body = undefined;
      }
      if (response.ok) {
        if (body === undefined) throw new ShipcastApiError(response.status, 'bad_response', `Shipcast answered ${response.status} without JSON; is ${base || 'this origin'} a Shipcast app?`);
        return body as T;
      }
      const error = typeof body === 'object' && body !== null && 'error' in body ? (body as { error: unknown }).error : undefined;
      const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' && CODES.has(error.code) ? (error.code as ApiErrorCode) : codeFor(response.status);
      const message = typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string' ? error.message : `HTTP ${response.status}`;
      const retry = Number(response.headers.get('retry-after'));
      throw new ShipcastApiError(response.status, code, redact(message, options.token), Number.isFinite(retry) && retry > 0 ? retry : undefined);
    },
  };
}
