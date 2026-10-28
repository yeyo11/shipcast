import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { imageUrl } from '@shipcast/schema';
import { appContext } from './context.server';
import { cookieOf, readSession, SESSION_COOKIE } from './session.server';

/**
 * Who is signed in; the middleware already turned away anyone who is not. A session from a console
 * link, or from before pictures were kept, gets GitHub's public picture for the login, which needs
 * no token.
 */
export const whoAmI = createServerFn({ method: 'GET' }).handler(async () => {
  const ctx = await appContext();
  const session = await readSession(ctx.secrets, cookieOf(getRequest(), SESSION_COOKIE));
  const login = session?.login ?? '';
  const fallback = login ? `https://avatars.githubusercontent.com/${encodeURIComponent(login)}?size=64` : null;
  // With realtime-ui the tab opens the event stream instead of polling (components/live)
  return { login, name: session?.name ?? null, avatarUrl: imageUrl(session?.avatarUrl) ?? fallback, live: ctx.live !== undefined };
});
