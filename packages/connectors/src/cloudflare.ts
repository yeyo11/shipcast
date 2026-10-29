import { sourceOfReferrer } from '@shipcast/schema';
import { checkProblem, ConnectorError, json, statsOf, type Check, type Metrics, type ProfileStats } from './http.ts';

export interface PageVisits {
  /** Page views of the path in the period */
  views: number;
  /** Visits: page views that came from another site or a direct link, not from the site's own pages */
  visits: number;
  /** Views by where they came from: a channel, `search`, `direct` or `other` */
  bySource: Record<string, number>;
}

/**
 * Cloudflare Web Analytics through the GraphQL Analytics API: page views and visits of one path of
 * the site, grouped by referrer host and path, so the blog's numbers say which channel sent each
 * visit (sourceOfReferrer; RUM keeps no query string, so neither `?ref=` nor the UTM tags are seen).
 * Needs an API token with Account Analytics read; the site tag identifies the site.
 */
export class CloudflareAnalytics {
  readonly #token: string;
  readonly #account: string;
  readonly #siteTag: string;
  readonly #fetch: typeof fetch;

  constructor(options: { apiToken: string; accountId: string; siteTag: string; fetch?: typeof fetch }) {
    this.#token = options.apiToken;
    this.#account = options.accountId;
    this.#siteTag = options.siteTag;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  /** A query for yesterday's views of the home page: proves the token, the account and the site tag together */
  async check(): Promise<Check> {
    try {
      const day = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
      const visits = await this.pageVisits('/', day, day);
      return { ok: true, account: `site ${this.#siteTag.slice(0, 8)}…, ${visits.views} views of / yesterday` };
    } catch (error) {
      return checkProblem(error);
    }
  }

  /** The blog's visits over the last seven days, every page: the number its card shows */
  async profileStats(): Promise<ProfileStats> {
    const until = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const since = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
    const visits = await this.pageVisits(undefined, since, until);
    return statsOf({}, { visits7d: visits.views });
  }

  /**
   * The visits of many paths in one query, grouped by path and referrer: what the hourly reads ask
   * for every article at once, instead of one query per path. `since` is the earliest launch's: an
   * article's path had no visits before it existed, so a wider window adds nothing to it.
   */
  async pageVisitsMany(paths: readonly string[], since: string, until: string): Promise<Map<string, PageVisits>> {
    const out = new Map<string, PageVisits>(paths.map((p) => [p, { views: 0, visits: 0, bySource: {} }]));
    if (paths.length === 0) return out;
    const query = `query($account: String!, $filter: AccountRumPageloadEventsAdaptiveGroupsFilter_InputObject!) {
      viewer { accounts(filter: { accountTag: $account }) {
        rumPageloadEventsAdaptiveGroups(limit: 10000, filter: $filter) {
          count
          sum { visits }
          dimensions { requestPath refererHost refererPath }
        }
      } }
    }`;
    const response = await this.#fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.#token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables: { account: this.#account, filter: { siteTag: this.#siteTag, requestPath_in: [...paths], date_geq: since, date_leq: until } } }),
    });
    const body = await json<{
      data?: { viewer: { accounts: Array<{ rumPageloadEventsAdaptiveGroups: Array<Group & { dimensions: { requestPath?: string } }> }> } };
      errors?: Array<{ message: string }> | null;
    }>('Cloudflare', response, 'page visits');
    if (body.errors?.length) throw new ConnectorError('Cloudflare', body.errors.map((e) => e.message).join('; '));
    for (const group of body.data?.viewer.accounts[0]?.rumPageloadEventsAdaptiveGroups ?? []) {
      const visits = group.dimensions.requestPath === undefined ? undefined : out.get(group.dimensions.requestPath);
      if (visits) add(visits, group);
    }
    return out;
  }

  /**
   * Many paths' page views and visits day by day (UTC days), each under the day it happened, in one
   * query grouped by day and path. Past seven days Cloudflare keeps about a tenth of the events and
   * scales them back up, so an older day read again may move a little: the newest read is kept.
   */
  async pageVisitsByDay(paths: readonly string[], since: string, until: string): Promise<Map<string, Record<string, { views: number; visits: number }>>> {
    const out = new Map<string, Record<string, { views: number; visits: number }>>(paths.map((p) => [p, {}]));
    if (paths.length === 0) return out;
    const query = `query($account: String!, $filter: AccountRumPageloadEventsAdaptiveGroupsFilter_InputObject!) {
      viewer { accounts(filter: { accountTag: $account }) {
        rumPageloadEventsAdaptiveGroups(limit: 10000, filter: $filter) {
          count
          sum { visits }
          dimensions { date requestPath }
        }
      } }
    }`;
    const response = await this.#fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.#token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables: { account: this.#account, filter: { siteTag: this.#siteTag, requestPath_in: [...paths], date_geq: since, date_leq: until } } }),
    });
    const body = await json<{
      data?: { viewer: { accounts: Array<{ rumPageloadEventsAdaptiveGroups: Array<{ count: number; sum?: { visits?: number }; dimensions: { date?: string; requestPath?: string } }> }> } };
      errors?: Array<{ message: string }> | null;
    }>('Cloudflare', response, 'page visits by day');
    if (body.errors?.length) throw new ConnectorError('Cloudflare', body.errors.map((e) => e.message).join('; '));
    for (const group of body.data?.viewer.accounts[0]?.rumPageloadEventsAdaptiveGroups ?? []) {
      const { date, requestPath } = group.dimensions;
      const days = requestPath === undefined ? undefined : out.get(requestPath);
      if (!days || !date) continue;
      const day = (days[date] ??= { views: 0, visits: 0 });
      day.views += group.count;
      day.visits += group.sum?.visits ?? 0;
    }
    return out;
  }

  /** Views of `path` (e.g. `/en/claudio/`), or of the whole site without one, between two dates (YYYY-MM-DD, inclusive). */
  async pageVisits(path: string | undefined, since: string, until: string): Promise<PageVisits> {
    const query = `query($account: String!, $filter: AccountRumPageloadEventsAdaptiveGroupsFilter_InputObject!) {
      viewer { accounts(filter: { accountTag: $account }) {
        rumPageloadEventsAdaptiveGroups(limit: 1000, filter: $filter) {
          count
          sum { visits }
          dimensions { refererHost refererPath }
        }
      } }
    }`;
    const response = await this.#fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.#token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        query,
        variables: {
          account: this.#account,
          filter: { siteTag: this.#siteTag, ...(path !== undefined && { requestPath: path }), date_geq: since, date_leq: until },
        },
      }),
    });
    const body = await json<{
      data?: { viewer: { accounts: Array<{ rumPageloadEventsAdaptiveGroups: Group[] }> } };
      errors?: Array<{ message: string }> | null;
    }>('Cloudflare', response, 'page visits');
    if (body.errors?.length) throw new ConnectorError('Cloudflare', body.errors.map((e) => e.message).join('; '));

    const visits: PageVisits = { views: 0, visits: 0, bySource: {} };
    for (const group of body.data?.viewer.accounts[0]?.rumPageloadEventsAdaptiveGroups ?? []) add(visits, group);
    return visits;
  }
}

/** One group of Web Analytics' answer: page views and visits from one referrer */
interface Group {
  count: number;
  sum?: { visits?: number };
  dimensions: { refererHost?: string; refererPath?: string };
}

/** A group's page views and visits added to a path's, under the source its referrer names */
function add(visits: PageVisits, group: Group): void {
  visits.views += group.count;
  visits.visits += group.sum?.visits ?? 0;
  const source = sourceOfReferrer(group.dimensions.refererHost, group.dimensions.refererPath);
  visits.bySource[source] = (visits.bySource[source] ?? 0) + group.count;
}

/** Flattens page visits into metrics: `views`, `visits`, and `views_<source>` per source. */
export function visitsToMetrics(visits: PageVisits): Metrics {
  const metrics: Metrics = { views: visits.views, visits: visits.visits };
  for (const [source, count] of Object.entries(visits.bySource)) metrics[`views_${source}`] = count;
  return metrics;
}
