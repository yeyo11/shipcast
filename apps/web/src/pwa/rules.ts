/*
 * What the service worker (sw.ts) does with each request, as one pure rule the tests hold
 * (docs/decisions/pwa.md). Only the build's public files are ever cached: the hashed assets, the
 * design folder's fonts, tokens and logo, the icons and the offline page. Everything the session
 * guards, every page included, goes to the network and is never written to a cache, so nothing
 * private outlives a sign-out; a page that cannot be reached shows the offline page instead.
 */

export type SwStrategy =
  /** Not the worker's business: another origin, or any method but GET; the browser does as it would */
  | 'pass'
  /** To the network only, never stored: data, server functions, media, auth, health */
  | 'network-only'
  /** A page: the network only, never stored; the offline page when the network fails */
  | 'navigate'
  /** A file whose name changes with its content (/assets/*): the cache first, then the network */
  | 'cache-first'
  /** A public file with a stable name (fonts, tokens, logo, icons): the cache at once, refreshed behind */
  | 'stale-while-revalidate';

/**
 * Paths that always go to the network, whatever the request looks like. Kept as a list the tests read,
 * so a new private door is added here and checked there.
 */
export const PRIVATE_PATHS: readonly RegExp[] = [
  /^\/api(\/|$)/,
  /^\/mcp(\/|$)/,
  /^\/media(\/|$)/,
  /^\/uploads(\/|$)/,
  /^\/avatars(\/|$)/,
  /^\/auth(\/|$)/,
  /^\/login(\/|$)/,
  /^\/livez$/,
  /^\/readyz$/,
  // TanStack Start's server functions: every page's data
  /^\/_serverFn(\/|$)/,
  // The worker itself and the manifest are checked by the browser on their own terms
  /^\/sw\.js$/,
  /^\/manifest\.webmanifest$/,
];

/** Public files whose names carry their content's hash: they never change under the same name */
const HASHED = /^\/assets\//;

/** Public files of the design folder and the icons: stable names, no session needed to read them */
const PUBLIC_FILES = [/^\/fonts\/[\w.-]+\.woff2$/, /^\/logo\/[\w.-]+\.svg$/, /^\/pwa\/[\w.-]+\.png$/, /^\/icons\/[\w.-]+\.svg$/, /^\/tokens\.css$/, /^\/offline\.html$/];

export interface SwRequest {
  method: string;
  /** The request's absolute URL */
  url: string;
  /** `navigate` for a page the browser opens */
  mode: string;
  /** The worker's own origin, `https://host` */
  origin: string;
}

export function swStrategy(request: SwRequest): SwStrategy {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return 'pass';
  }
  if (url.origin !== request.origin) return 'pass';
  if (request.method !== 'GET') return 'pass';
  const path = url.pathname;
  if (PRIVATE_PATHS.some((p) => p.test(path))) return 'network-only';
  if (request.mode === 'navigate') return 'navigate';
  // A query string on a public file is someone else's idea (a cache-buster, a signed link): left to the network
  if (url.search) return 'network-only';
  if (HASHED.test(path)) return 'cache-first';
  if (PUBLIC_FILES.some((p) => p.test(path))) return 'stale-while-revalidate';
  return 'network-only';
}

/** Whether a request is the sign-out, after which the worker empties its runtime cache */
export const isSignOut = (request: Pick<SwRequest, 'url' | 'method' | 'origin'>): boolean => {
  try {
    const url = new URL(request.url);
    return url.origin === request.origin && url.pathname === '/auth/logout';
  } catch {
    return false;
  }
};

/**
 * Whether a response may be stored: a whole, successful, same-origin answer the server said may be
 * shared. A private or no-store answer is never kept, even on a path the rule calls public.
 */
export function cacheable(response: { ok: boolean; status: number; type: string; headers: { get(name: string): string | null } }): boolean {
  if (!response.ok || response.status !== 200 || response.type !== 'basic') return false;
  const control = (response.headers.get('cache-control') ?? '').toLowerCase();
  if (/\b(no-store|private)\b/.test(control)) return false;
  if (response.headers.get('set-cookie') !== null) return false;
  return true;
}
