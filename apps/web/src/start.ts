import { createCsrfMiddleware, createMiddleware, createStart } from '@tanstack/react-start';

/** GitHub's deliveries: no session and no same-origin, since GitHub sends them; their signature is checked instead */
const WEBHOOK = '/api/github/webhook';

/** Paths anyone may open: signing in, the static files the sign-in page needs, the health check and GitHub's webhook */
const PUBLIC = [/^\/login$/, /^\/auth\/(github|github\/callback|link)$/, /^\/(assets|fonts|logo)\//, /^\/favicon\.svg$/, /^\/api\/health$/, /^\/api\/github\/webhook$/];

/**
 * Every other request needs a session. A page without one goes to the sign-in page; anything else
 * (a server function, an API call) gets a 401, so a script never mistakes the sign-in page for data.
 */
const requireSession = createMiddleware().server(async ({ request, pathname, next }) => {
  if (PUBLIC.some((p) => p.test(pathname))) return next();
  const { appContext } = await import('./server/context.server');
  const { cookieOf, readSession, SESSION_COOKIE } = await import('./server/session.server');
  const session = await readSession(appContext().secrets, cookieOf(request, SESSION_COOKIE));
  if (session) return next({ context: { login: session.login } });
  const isPage = request.method === 'GET' && (request.headers.get('accept') ?? '').includes('text/html');
  return isPage ? new Response(null, { status: 302, headers: { location: '/login' } }) : new Response('Sign in first', { status: 401 });
});

/** Anything that changes something must come from the app's own pages */
const sameOrigin = createCsrfMiddleware({ filter: ({ request, pathname }) => request.method !== 'GET' && request.method !== 'HEAD' && pathname !== WEBHOOK });

export const startInstance = createStart(() => ({ requestMiddleware: [sameOrigin, requireSession] }));
