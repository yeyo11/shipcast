import { createCsrfMiddleware, createMiddleware, createStart } from '@tanstack/react-start';
import { loginPath, SESSION_HEADER } from './server/next-path';

/** GitHub's deliveries: no session and no same-origin, since GitHub sends them; their signature is checked instead */
const WEBHOOK = '/api/github/webhook';

/**
 * The REST API checks its own bearer tokens and never reads the session cookie (server/api.ts), so
 * neither the session nor the same-origin check applies: a request without the token is refused
 * there, and a page on another site cannot set an Authorization header without a CORS preflight the
 * app never answers. See docs/decisions/api-tokens.md
 */
const API = /^\/api\/v1\//;

/** The MCP endpoint is the API's other door: the same bearer tokens, checked there (routes/mcp.ts), never the cookie */
const MCP = /^\/mcp$/;

/** Paths anyone may open: signing in, the static files the sign-in page needs, the health check and GitHub's webhook */
const PUBLIC = [/^\/login$/, /^\/auth\/(github|github\/callback|link)$/, /^\/(assets|fonts|logo)\//, /^\/favicon\.svg$/, /^\/api\/health$/, /^\/api\/github\/webhook$/, API, MCP];

/**
 * Every other request needs a session. A page without one goes to the sign-in page, which brings the
 * owner back to it afterwards; anything else (a server function, an API call) gets a 401, so a script
 * never mistakes the sign-in page for data. The 401 says why in a header, which the app's pages read
 * to send the owner to sign in again instead of showing an error (components/SessionExpiry.tsx).
 */
const requireSession = createMiddleware().server(async ({ request, pathname, next }) => {
  if (PUBLIC.some((p) => p.test(pathname))) return next();
  const { appContext } = await import('./server/context.server');
  const { cookieOf, readSession, SESSION_COOKIE } = await import('./server/session.server');
  const session = await readSession((await appContext()).secrets, cookieOf(request, SESSION_COOKIE));
  if (session) return next({ context: { login: session.login } });
  const isPage = request.method === 'GET' && (request.headers.get('accept') ?? '').includes('text/html');
  if (isPage) {
    const url = new URL(request.url);
    return new Response(null, { status: 302, headers: { location: loginPath(`${url.pathname}${url.search}`) } });
  }
  return new Response('Sign in first', { status: 401, headers: { [SESSION_HEADER]: 'required' } });
});

/**
 * The measurement (server/timing.server.ts): pages and API requests timed, with a Server-Timing
 * header; a server function's request only marked, since its function is timed on its own below
 */
const timeRequests = createMiddleware().server(async ({ request, pathname, handlerType, next }) => {
  const { markServerFnRequest, timeRequest } = await import('./server/timing.server');
  if (handlerType === 'serverFn') return markServerFnRequest(request, () => Promise.resolve(next()));
  const result = await timeRequest(request, pathname, async () => (await next()).response);
  return result;
});

/** Every server function, timed under its own name, whether the page's render or the browser called it */
const timeServerFns = createMiddleware({ type: 'function' }).server(async ({ serverFnMeta, next }) => {
  const { timeServerFn } = await import('./server/timing.server');
  return timeServerFn(serverFnMeta.name, () => Promise.resolve(next()));
});

/** Anything that changes something must come from the app's own pages */
const sameOrigin = createCsrfMiddleware({ filter: ({ request, pathname }) => request.method !== 'GET' && request.method !== 'HEAD' && pathname !== WEBHOOK && !API.test(pathname) && !MCP.test(pathname) });

export const startInstance = createStart(() => ({ requestMiddleware: [timeRequests, sameOrigin, requireSession], functionMiddleware: [timeServerFns] }));
