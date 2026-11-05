import { ConnectorError, json } from '../http.ts';
import { GRAPH, graphGet, graphId, META_GRAPH_VERSION, tokenAnswer, type TokenAnswer } from './graph.ts';

/** Facebook Login for Business asks by configuration (its permissions live in the Meta app), never by scope */
export function facebookDialogUrl(app: { appId: string; configId: string }, redirectUri: string, state: string): string {
  const query = new URLSearchParams({ client_id: app.appId, redirect_uri: redirectUri, response_type: 'code', config_id: app.configId, state });
  return `https://www.facebook.com/${META_GRAPH_VERSION}/dialog/oauth?${query}`;
}

export function exchangeFacebookCode(
  app: { appId: string; appSecret: string },
  redirectUri: string,
  code: string,
  http: typeof fetch = globalThis.fetch,
): Promise<TokenAnswer> {
  return graphToken({ client_id: app.appId, client_secret: app.appSecret, redirect_uri: redirectUri, code }, 'exchange the code', http);
}

/** The user token the code gave lasts an hour; this one lasts about 60 days */
export function longLivedUserToken(app: { appId: string; appSecret: string }, accessToken: string, http: typeof fetch = globalThis.fetch): Promise<TokenAnswer> {
  return graphToken({ grant_type: 'fb_exchange_token', client_id: app.appId, client_secret: app.appSecret, fb_exchange_token: accessToken }, 'get a long-lived token', http);
}

async function graphToken(params: Record<string, string>, what: string, http: typeof fetch): Promise<TokenAnswer> {
  const response = await http(`${GRAPH}/oauth/access_token?${new URLSearchParams(params)}`);
  return tokenAnswer(await json<{ access_token?: unknown; expires_in?: unknown }>('Meta', response, what), what);
}

export interface FacebookPageAsset {
  pageId: string;
  name: string;
  pageToken: string;
  instagram: { id: string; username: string | undefined } | undefined;
}

interface PagesAnswer {
  data?: Array<{ id?: unknown; name?: unknown; access_token?: unknown; instagram_business_account?: { id?: unknown; username?: unknown } }>;
  paging?: { next?: string };
}

/** Every Page the user granted, with its own token and the Instagram account linked to it */
export async function listPages(userToken: string, http: typeof fetch = globalThis.fetch): Promise<FacebookPageAsset[]> {
  const pages: FacebookPageAsset[] = [];
  let answer = await graphGet<PagesAnswer>('/me/accounts', { fields: 'id,name,access_token,instagram_business_account{id,username}' }, userToken, 'list the Pages', http);
  for (let guard = 0; guard < 50; guard++) {
    for (const page of answer.data ?? []) {
      if (typeof page.access_token !== 'string') throw new ConnectorError('Meta', 'list the Pages: a Page came without its token');
      const ig = page.instagram_business_account;
      pages.push({
        pageId: graphId(page.id, 'list the Pages'),
        name: typeof page.name === 'string' ? page.name : '',
        pageToken: page.access_token,
        instagram: ig ? { id: graphId(ig.id, 'list the Pages'), username: typeof ig.username === 'string' ? ig.username : undefined } : undefined,
      });
    }
    const next = answer.paging?.next;
    if (!next) return pages;
    // `next` is a full URL that already carries the token
      answer = await json<PagesAnswer>('Meta', await http(next), 'list the Pages');
  }
  throw new ConnectorError('Meta', 'list the Pages: too many pages of results');
}
