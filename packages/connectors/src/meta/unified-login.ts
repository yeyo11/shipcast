import { ConnectorError, json } from '../http.ts';
import { exchangeFacebookCode } from './facebook-login.ts';
import { graphGet, graphId } from './graph.ts';

/** What the Instagram side of a Unified Login configuration is asked for in the Meta app */
export const UNIFIED_INSTAGRAM_PERMISSIONS: readonly string[] = ['instagram_basic', 'instagram_content_publish', 'instagram_manage_comments', 'instagram_manage_insights'];

export interface UnifiedAccess {
  accessToken: string;
  businessId: string;
  instagram: Array<{ id: string; username: string | undefined }>;
}

interface AssignedAnswer {
  data?: Array<{ id?: unknown; username?: unknown }>;
  paging?: { next?: string };
}

/**
 * The business integration system user token a Unified Login code is worth, the business it belongs
 * to and the Instagram accounts assigned to it.
 */
export async function unifiedAccess(
  app: { appId: string; appSecret: string },
  redirectUri: string,
  code: string,
  http: typeof fetch = globalThis.fetch,
): Promise<UnifiedAccess> {
  const { accessToken } = await exchangeFacebookCode(app, redirectUri, code, http);
  const me = await graphGet<{ client_business_id?: unknown }>('/me', { fields: 'client_business_id' }, accessToken, 'read the business', http);
  const businessId = graphId(me.client_business_id, 'read the business');
  const instagram: UnifiedAccess['instagram'] = [];
  let answer = await graphGet<AssignedAnswer>('/me/assigned_instagram_accounts', { fields: 'id,username' }, accessToken, 'list the Instagram accounts', http);
  for (let guard = 0; guard < 50; guard++) {
    for (const account of answer.data ?? []) {
      instagram.push({ id: graphId(account.id, 'list the Instagram accounts'), username: typeof account.username === 'string' ? account.username : undefined });
    }
    const next = answer.paging?.next;
    if (!next) return { accessToken, businessId, instagram };
    answer = await json<AssignedAnswer>('Meta', await http(next), 'list the Instagram accounts');
  }
  throw new ConnectorError('Meta', 'list the Instagram accounts: too many pages of results');
}
