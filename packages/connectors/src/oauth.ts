import { ConnectorError, json } from './http.ts';
import { REDDIT_SCOPES } from './reddit.ts';

/**
 * The OAuth flows of the networks that offer one, as plain functions: the web app sends the owner's
 * browser to `authorizeUrl`, and exchanges the code the network sends back to its callback. Nothing
 * here keeps state; the caller holds the `state` value and the app's client credentials.
 */

/** What publishing and the metrics need on Mastodon, and nothing more */
export const MASTODON_SCOPES = 'read:accounts read:statuses write:statuses write:media';

/**
 * Mastodon has no central developer portal: each instance registers its own apps, so Shipcast
 * registers itself on the instance the owner names, the first time an account there is connected.
 */
export async function registerMastodonApp(
  instance: string,
  redirectUri: string,
  http: typeof fetch = globalThis.fetch,
): Promise<{ clientId: string; clientSecret: string }> {
  const response = await http(`${instance.replace(/\/+$/, '')}/api/v1/apps`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Shipcast', redirect_uris: redirectUri, scopes: MASTODON_SCOPES, website: 'https://github.com/yeyo11/shipcast' }),
  });
  const app = await json<{ client_id: string; client_secret: string }>('Mastodon', response, 'register the app');
  return { clientId: app.client_id, clientSecret: app.client_secret };
}

export function mastodonAuthorizeUrl(instance: string, clientId: string, redirectUri: string, state: string): string {
  const query = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, scope: MASTODON_SCOPES, state });
  return `${instance.replace(/\/+$/, '')}/oauth/authorize?${query}`;
}

/** Mastodon's tokens do not expire; they last until the owner revokes them */
export async function exchangeMastodonCode(
  instance: string,
  app: { clientId: string; clientSecret: string },
  redirectUri: string,
  code: string,
  http: typeof fetch = globalThis.fetch,
): Promise<string> {
  const response = await http(`${instance.replace(/\/+$/, '')}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: app.clientId,
      client_secret: app.clientSecret,
      redirect_uri: redirectUri,
      scope: MASTODON_SCOPES,
    }),
  });
  return (await json<{ access_token: string }>('Mastodon', response, 'exchange the code')).access_token;
}

/** Publishing, insights and comments, the permissions the Instagram connector uses */
export const INSTAGRAM_SCOPES = [
  'instagram_business_basic',
  'instagram_business_content_publish',
  'instagram_business_manage_insights',
  'instagram_business_manage_comments',
];

/** Instagram Login: the redirect URI must be listed, exactly, in the Meta app's business login settings */
export function instagramAuthorizeUrl(appId: string, redirectUri: string, state: string): string {
  const query = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: INSTAGRAM_SCOPES.join(','),
    state,
    enable_fb_login: '0',
  });
  return `https://www.instagram.com/oauth/authorize?${query}`;
}

/**
 * The code is worth a short-lived token (an hour), which is swapped at once for a long-lived one (60
 * days, refreshed every 30 by `Instagram.refreshToken`). Both steps need the app secret.
 */
export async function exchangeInstagramCode(
  app: { appId: string; appSecret: string },
  redirectUri: string,
  code: string,
  http: typeof fetch = globalThis.fetch,
): Promise<{ userId: string; accessToken: string; expiresIn: number }> {
  // Instagram appends `#_` to the code it redirects with
  const clean = code.replace(/#_$/, '');
  // As Postiz does, whose flow works against the same API: the code goes as multipart form data
  const form = new FormData();
  form.append('client_id', app.appId);
  form.append('client_secret', app.appSecret);
  form.append('grant_type', 'authorization_code');
  form.append('redirect_uri', redirectUri);
  form.append('code', clean);
  type ShortToken = { access_token?: string; user_id?: number | string; permissions?: string };
  const answer = await json<ShortToken & { data?: ShortToken[] }>(
    'Instagram',
    await http('https://api.instagram.com/oauth/access_token', { method: 'POST', body: form }),
    'exchange the code',
  );
  const short = answer.access_token ? answer : answer.data?.[0];
  if (!short?.access_token) throw new ConnectorError('Instagram', 'the code exchange returned no access token');
  const query = new URLSearchParams({ grant_type: 'ig_exchange_token', client_id: app.appId, client_secret: app.appSecret, access_token: short.access_token });
  const exchanged = await http(`https://graph.instagram.com/access_token?${query}`);
  if (!exchanged.ok) {
    // Which account Instagram issued the token for, and what it granted: the facts to compare with the dashboard
    throw new ConnectorError(
      'Instagram',
      `get a long-lived token: ${exchanged.status} ${(await exchanged.text()).slice(0, 300)}; the code was issued for user ${short.user_id ?? 'unknown'} with ${short.permissions ?? 'no listed permissions'}`,
      exchanged.status,
    );
  }
  const long = await json<{ access_token: string; expires_in: number }>('Instagram', exchanged, 'get a long-lived token');
  // The exchange's user_id is a JSON number past 2^53, so it reaches JavaScript already rounded: the
  // account's id is read from /me, as text, with the token just issued
  const me = await http(`https://graph.instagram.com/v25.0/me?${new URLSearchParams({ fields: 'user_id,username', access_token: long.access_token })}`);
  const text = await me.text();
  if (!me.ok) throw new ConnectorError('Instagram', `read the account: ${me.status} ${text.slice(0, 300)}`, me.status);
  const userId = /"user_id"\s*:\s*"?(\d+)/.exec(text)?.[1];
  if (!userId) throw new ConnectorError('Instagram', 'the account has no user_id: it is not a professional account');
  return { userId, accessToken: long.access_token, expiresIn: long.expires_in };
}

/** Publishing, deleting, replies and insights: every permission the Threads connector uses */
export const THREADS_SCOPES = [
  'threads_basic',
  'threads_content_publish',
  'threads_read_replies',
  'threads_manage_replies',
  'threads_manage_insights',
  'threads_delete',
];

/** Threads' authorisation window; the redirect URI must be listed, exactly, in the Meta app's Threads use case */
export function threadsAuthorizeUrl(appId: string, redirectUri: string, state: string): string {
  const query = new URLSearchParams({ client_id: appId, redirect_uri: redirectUri, scope: THREADS_SCOPES.join(','), response_type: 'code', state });
  return `https://threads.com/oauth/authorize?${query}`;
}

/**
 * As Instagram's: the code is worth a short-lived token (an hour), swapped at once for a long-lived
 * one (60 days, refreshed every 30 by `Threads.refreshToken`). Both steps need the app secret.
 */
export async function exchangeThreadsCode(
  app: { appId: string; appSecret: string },
  redirectUri: string,
  code: string,
  http: typeof fetch = globalThis.fetch,
): Promise<{ userId: string; accessToken: string; expiresIn: number }> {
  const response = await http('https://graph.threads.com/oauth/access_token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    // Threads appends `#_` to the redirect, which is not part of the code
    body: new URLSearchParams({ client_id: app.appId, client_secret: app.appSecret, grant_type: 'authorization_code', redirect_uri: redirectUri, code: code.replace(/#_$/, '') }),
  });
  // The user id can be a number past 2^53 in JSON: it is read as text, before JSON.parse rounds it
  const text = await response.text();
  if (!response.ok) throw new ConnectorError('Threads', `exchange the code: ${response.status} ${text.slice(0, 300)}`, response.status);
  let short: { access_token?: string };
  try {
    short = JSON.parse(text) as typeof short;
  } catch {
    throw new ConnectorError('Threads', 'exchange the code: the answer is not JSON', response.status);
  }
  const userId = /"user_id"\s*:\s*"?(\d+)/.exec(text)?.[1];
  if (!short.access_token || !userId) throw new ConnectorError('Threads', 'the code exchange returned no access token or user id');
  const query = new URLSearchParams({ grant_type: 'th_exchange_token', client_secret: app.appSecret, access_token: short.access_token });
  const long = await json<{ access_token: string; expires_in: number }>('Threads', await http(`https://graph.threads.com/access_token?${query}`), 'get a long-lived token');
  return { userId, accessToken: long.access_token, expiresIn: long.expires_in };
}

/** Sign In with LinkedIn using OpenID Connect (openid, profile) and Share on LinkedIn (w_member_social) */
export const LINKEDIN_SCOPES = ['openid', 'profile', 'w_member_social'];

/** The redirect URI must be listed, exactly, under the LinkedIn app's Auth → Authorized redirect URLs */
export function linkedinAuthorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const query = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, state, scope: LINKEDIN_SCOPES.join(' ') });
  return `https://www.linkedin.com/oauth/v2/authorization?${query}`;
}

/**
 * The code becomes an access token of 60 days; LinkedIn gives refresh tokens only to the partners it
 * approves, so the owner connects again when it runs out. The member's id comes from userinfo.
 */
export async function exchangeLinkedInCode(
  app: { clientId: string; clientSecret: string },
  redirectUri: string,
  code: string,
  http: typeof fetch = globalThis.fetch,
): Promise<{ personId: string; name: string | undefined; accessToken: string; expiresIn: number }> {
  const response = await http('https://www.linkedin.com/oauth/v2/accessToken', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: app.clientId, client_secret: app.clientSecret, redirect_uri: redirectUri }),
  });
  const token = await json<{ access_token: string; expires_in: number }>('LinkedIn', response, 'exchange the code');
  const me = await json<{ sub: string; name?: string }>(
    'LinkedIn',
    await http('https://api.linkedin.com/v2/userinfo', { headers: { authorization: `Bearer ${token.access_token}` } }),
    'read the member',
  );
  return { personId: me.sub, name: me.name, accessToken: token.access_token, expiresIn: token.expires_in };
}

/**
 * `duration=permanent` asks for a refresh token that does not expire, so the account stays
 * connected; the redirect URI must be the app's own "redirect uri", exactly.
 */
export function redditAuthorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const query = new URLSearchParams({ client_id: clientId, response_type: 'code', state, redirect_uri: redirectUri, duration: 'permanent', scope: REDDIT_SCOPES.join(' ') });
  return `https://www.reddit.com/api/v1/authorize?${query}`;
}

/**
 * The code becomes an access token of an hour and the permanent refresh token, which is all that is
 * kept; the account's name comes from /api/v1/me. Reddit answers a bad code with a 200 and an error.
 */
export async function exchangeRedditCode(
  app: { clientId: string; clientSecret: string },
  redirectUri: string,
  code: string,
  http: typeof fetch = globalThis.fetch,
): Promise<{ username: string; refreshToken: string }> {
  const response = await http('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
      // The account is not known yet; Reddit only asks that the agent say what it is
      'user-agent': 'web:dev.shipcast:1',
    },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
  });
  const token = await json<{ access_token?: string; refresh_token?: string; error?: string }>('Reddit', response, 'exchange the code');
  if (!token.access_token || !token.refresh_token) throw new ConnectorError('Reddit', `the code was refused (${token.error ?? 'no permanent token'})`, 400, false);
  const me = await json<{ name: string }>(
    'Reddit',
    await http('https://oauth.reddit.com/api/v1/me', { headers: { authorization: `bearer ${token.access_token}`, 'user-agent': 'web:dev.shipcast:1' } }),
    'read the account',
  );
  return { username: me.name, refreshToken: token.refresh_token };
}
