import { ConnectorError, json } from '../http.ts';

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
