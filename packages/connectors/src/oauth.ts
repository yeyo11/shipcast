import { ConnectorError, json } from './http.ts';

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
    // Without it, an account connected once is never asked again for a permission added later
    enable_fb_login: '0',
    force_reauth: 'true',
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
  type ShortToken = { access_token: string; user_id: number | string };
  const answer = await json<ShortToken | { data: ShortToken[] }>(
    'Instagram',
    await http('https://api.instagram.com/oauth/access_token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: app.appId, client_secret: app.appSecret, grant_type: 'authorization_code', redirect_uri: redirectUri, code: clean }),
    }),
    'exchange the code',
  );
  // Business Login answers inside `data`; the older flow answered at the top level
  const short = 'data' in answer ? answer.data[0] : answer;
  if (!short?.access_token) throw new ConnectorError('Instagram', 'the code exchange returned no access token');
  const query = new URLSearchParams({ grant_type: 'ig_exchange_token', client_secret: app.appSecret, access_token: short.access_token });
  const exchanged = await http(`https://graph.instagram.com/access_token?${query}`);
  if (!exchanged.ok) {
    // Meta refuses this step for some accounts with no clear cause: say whether the short-lived token works at all
    const me = await http(`https://graph.instagram.com/me?${new URLSearchParams({ fields: 'user_id,username', access_token: short.access_token })}`);
    const body = await exchanged.text();
    throw new ConnectorError(
      'Instagram',
      `get a long-lived token: ${exchanged.status} ${body.slice(0, 300)}; the short-lived token ${me.ok ? 'works' : `fails too (${me.status} ${(await me.text()).slice(0, 200)})`}; granted: ${'permissions' in short ? String((short as { permissions?: string }).permissions) : 'unknown'}`,
      exchanged.status,
    );
  }
  const long = await json<{ access_token: string; expires_in: number }>('Instagram', exchanged, 'get a long-lived token');
  return { userId: String(short.user_id), accessToken: long.access_token, expiresIn: long.expires_in };
}
