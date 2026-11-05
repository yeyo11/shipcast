import { ConnectorError, json } from '../http.ts';

export const META_GRAPH_VERSION = 'v27.0';

export const GRAPH = `https://graph.facebook.com/${META_GRAPH_VERSION}`;

/** A Graph `id` is text (ids pass 2^53 as numbers); anything else is Meta answering something unexpected */
export function graphId(value: unknown, what: string): string {
  if (typeof value !== 'string' || value === '') throw new ConnectorError('Meta', `${what}: the answer has no id as text`);
  return value;
}

/** GET on the Graph API with the token as the `access_token` query parameter */
export async function graphGet<T>(path: string, params: Record<string, string>, accessToken: string, what: string, http: typeof fetch): Promise<T> {
  const query = new URLSearchParams({ ...params, access_token: accessToken });
  return json<T>('Meta', await http(`${GRAPH}${path}?${query}`), what);
}

export interface TokenAnswer {
  accessToken: string;
  /** Absent for a business integration system user token, which does not expire */
  expiresIn: number | undefined;
}

export function tokenAnswer(answer: { access_token?: unknown; expires_in?: unknown }, what: string): TokenAnswer {
  if (typeof answer.access_token !== 'string' || !answer.access_token) throw new ConnectorError('Meta', `${what}: the answer has no access token`);
  return { accessToken: answer.access_token, expiresIn: typeof answer.expires_in === 'number' ? answer.expires_in : undefined };
}
