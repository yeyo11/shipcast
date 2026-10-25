import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { appContext } from './context.server';
import { cookieOf, readSession, SESSION_COOKIE } from './session.server';

/** Who is signed in; the middleware already turned away anyone who is not */
export const whoAmI = createServerFn({ method: 'GET' }).handler(async () => {
  const session = await readSession((await appContext()).secrets, cookieOf(getRequest(), SESSION_COOKIE));
  return { login: session?.login ?? '' };
});
