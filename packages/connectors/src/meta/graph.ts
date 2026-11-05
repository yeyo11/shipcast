import { ConnectorError, json } from '../http.ts';

export const META_GRAPH_VERSION = 'v27.0';

export const GRAPH = `https://graph.facebook.com/${META_GRAPH_VERSION}`;

/** A Graph `id` is text (ids pass 2^53 as numbers); anything else is Meta answering something unexpected */
export function graphId(value: unknown, what: string, network = 'Meta'): string {
  if (typeof value !== 'string' || value === '') throw new ConnectorError(network, `${what}: the answer has no id as text`);
  return value;
}

/** Graph API's (#100) when a set names a metric the object no longer has: the names follow */
const UNSUPPORTED = /does not support the metrics?:?\s*([a-z_]+(?:\s*,\s*[a-z_]+)*)/i;
/** Graph API's (#100), in the error's code or in its message, which the connector error carries */
const INVALID_PARAMETER = /"code"\s*:\s*100\b|\(#100\)/;

/**
 * The metrics Meta refused, by account and set, for as long as the process runs: a set is asked
 * without them from then on, so one retired metric costs one extra call, not every reading.
 */
const REFUSED = new Map<string, Set<string>>();

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Reads a set of insights, leaving out what Meta refuses. A refusal that names metrics drops them and
 * asks the set again once. With `probeUnnamed`, a (#100) that names none (the Page insights API says
 * only "must be a valid insights metric") asks each metric alone once to find the refused ones. A
 * refusal of the whole set, or of anything else, still fails. `key` names the account and the set.
 */
export async function readInsights<I>(
  key: string,
  metrics: readonly string[],
  read: (metrics: string[]) => Promise<I[]>,
  options: { probeUnnamed?: boolean } = {},
): Promise<I[]> {
  const refused = REFUSED.get(key) ?? new Set<string>();
  const ask = () => metrics.filter((m) => !refused.has(m));
  const remember = (names: readonly string[]) => {
    for (const m of names) refused.add(m);
    REFUSED.set(key, refused);
  };
  try {
    return await read(ask());
  } catch (error) {
    const asked = ask();
    const named = UNSUPPORTED.exec(errorText(error))?.[1]?.split(/\s*,\s*/).filter((m) => asked.includes(m)) ?? [];
    if (named.length > 0) {
      if (named.length === asked.length) throw error;
      remember(named);
      return read(ask());
    }
    if (!options.probeUnnamed || asked.length < 2 || !INVALID_PARAMETER.test(errorText(error))) throw error;
    const data: I[] = [];
    const alone: string[] = [];
    for (const m of asked) {
      try {
        data.push(...(await read([m])));
      } catch (single) {
        if (!INVALID_PARAMETER.test(errorText(single))) throw single;
        alone.push(m);
      }
    }
    if (alone.length === asked.length) throw error;
    remember(alone);
    return data;
  }
}

/** The metrics of a set Meta has refused for this account in this process */
export function refusedInsights(key: string): string[] {
  return [...(REFUSED.get(key) ?? [])];
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
