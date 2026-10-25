import { randomBytes } from 'node:crypto';
import { consoleLinks } from './console-links';
import { appContext } from './context.server';
import { cookieOf, createSession, SESSION_COOKIE, setCookie, STATE_COOKIE } from './session.server';

const redirect = (location: string, cookies: string[] = []) => {
  const headers = new Headers({ location });
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return new Response(null, { status: 302, headers });
};

const page = (status: number, message: string) =>
  new Response(`<!doctype html><meta charset="utf-8"><title>Shipcast</title><body style="font:16px system-ui;background:#141413;color:#F4F2EC;padding:3rem"><p>${message}</p><p><a style="color:#FFD43B" href="/login">Back to sign in</a></p>`, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });

const callbackUrl = (app: { publicUrl: string }) => `${app.publicUrl}/auth/github/callback`;

/** Sends the browser to GitHub with a fresh state, remembered in a short-lived cookie */
export async function startGitHubSignIn(): Promise<Response> {
  const { app } = await appContext();
  const state = randomBytes(18).toString('base64url');
  const query = new URLSearchParams({ client_id: app.github.clientId, redirect_uri: callbackUrl(app), state, allow_signup: 'false' });
  return redirect(`https://github.com/login/oauth/authorize?${query}`, [setCookie(STATE_COOKIE, state, 600)]);
}

/**
 * GitHub's way back: the state must match the cookie (or it is someone else's sign-in replayed
 * here), the code becomes a token for one call that names the user, and only allowed logins get a
 * session. The token itself is not kept: the app needs to know who, not to act as them.
 */
export async function finishGitHubSignIn(request: Request): Promise<Response> {
  const { app, secrets } = await appContext();
  const url = new URL(request.url);
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  const expected = cookieOf(request, STATE_COOKIE);
  const clearState = setCookie(STATE_COOKIE, '', 0);
  if (url.searchParams.get('error')) return page(400, `GitHub did not sign you in: ${url.searchParams.get('error_description') ?? url.searchParams.get('error')}.`);
  if (!state || !code || !expected || state !== expected) return page(400, 'This sign-in link is stale or was not started here.');

  const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: app.github.clientId, client_secret: app.github.clientSecret, code, redirect_uri: callbackUrl(app) }),
  });
  const token = (await tokenResponse.json()) as { access_token?: string; error_description?: string };
  if (!token.access_token) return page(502, `GitHub refused the sign-in: ${token.error_description ?? tokenResponse.status}.`);
  const userResponse = await fetch('https://api.github.com/user', {
    headers: { authorization: `Bearer ${token.access_token}`, accept: 'application/vnd.github+json', 'user-agent': 'shipcast' },
  });
  const user = (await userResponse.json()) as { login?: string };
  const login = user.login?.toLowerCase();
  if (!login) return page(502, 'GitHub did not say who you are.');
  if (!app.allowedLogins.includes(login)) return page(403, `@${user.login} is not allowed into this Shipcast.`);

  const session = await createSession(secrets, login);
  return redirect('/', [clearState, setCookie(SESSION_COOKIE, session.value, session.maxAge)]);
}

/** A console link signs in as the first allowed login: it is the owner at their own terminal */
export async function redeemConsoleLink(request: Request): Promise<Response> {
  const { app, secrets } = await appContext();
  const token = new URL(request.url).searchParams.get('token') ?? '';
  if (!consoleLinks().redeem(token)) return page(403, 'This sign-in link was used already or has expired. The app prints a new one when it starts.');
  const session = await createSession(secrets, app.allowedLogins[0]!);
  return redirect('/', [setCookie(SESSION_COOKIE, session.value, session.maxAge)]);
}

export function signOut(): Response {
  return redirect('/login', [setCookie(SESSION_COOKIE, '', 0)]);
}
