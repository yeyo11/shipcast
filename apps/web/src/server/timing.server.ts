import { PROBE_ORIGIN, telemetry, withOrigin } from '@shipcast/runtime';
import { PROBE_HEADER } from './probe.server';

/**
 * The measurement of the app's own work (docs/plans/performance-refactor.md, phase 0): each page and
 * API request, and each server function, timed and counted per hour, and the outbound calls made
 * while it runs counted under its name. Pages and API answers also say their time in a
 * `Server-Timing` header, which the browser's developer tools show.
 */

/** A path as a route: ids become `:n`, so `/launches/6` and `/launches/7` are one page */
export function routeOf(pathname: string): string {
  return pathname.replace(/\/\d+(?=\/|$)/g, '/:n').replace(/\/[0-9a-f]{16,}(?=\/|$)/gi, '/:id');
}

const isProbe = (request: Request) => request.headers.get(PROBE_HEADER) === '1';

/** Runs a page or API request under its route's name, and times it to its answer's headers */
export async function timeRequest(request: Request, pathname: string, next: () => Promise<Response>): Promise<Response> {
  const name = `${request.method} ${routeOf(pathname)}`;
  const kind = pathname.startsWith('/api/') || pathname === '/mcp' ? 'api' : 'page';
  const started = performance.now();
  let response: Response;
  try {
    response = await withOrigin(`${kind}:${routeOf(pathname)}`, next, { probe: isProbe(request) });
  } catch (error) {
    telemetry()?.timing({ kind: 'request', name, outcome: 'error', ms: performance.now() - started });
    throw error;
  }
  const ms = performance.now() - started;
  telemetry()?.timing({ kind: 'request', name, outcome: response.status >= 500 ? 'error' : 'ok', ms });
  return withServerTiming(response, ms);
}

/**
 * Runs a server function under its own name (`fn:getLaunch`), and times it: called by the page's
 * render or by the browser, a probe's request stays a probe (the request's origin is kept)
 */
export async function timeServerFn<T>(name: string, next: () => Promise<T>): Promise<T> {
  const recorder = telemetry();
  const run = () => withOrigin(`fn:${name}`, next);
  return recorder ? recorder.time('fn', name, run) : run();
}

/** A server function's request, untimed (its function is): only marked when the probe sent it */
export function markServerFnRequest<T>(request: Request, next: () => Promise<T>): Promise<T> {
  return isProbe(request) ? withOrigin(PROBE_ORIGIN, next, { probe: true }) : next();
}

function withServerTiming(response: Response, ms: number): Response {
  const value = `app;dur=${ms.toFixed(1)}`;
  try {
    response.headers.append('server-timing', value);
    return response;
  } catch {
    // A response whose headers are immutable (a redirect made by Response.redirect) is copied instead
    const headers = new Headers(response.headers);
    headers.append('server-timing', value);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
}
