import { checkProblem, ConnectorError, json, statsOf, type Check, type Metrics, type ProfileStats } from './http.ts';

export interface PageVisits {
  /** Page views of the path in the period */
  views: number;
  /** Views by where they came from: a channel, `search`, `direct` or `other` */
  bySource: Record<string, number>;
}

/**
 * The channel a visit came from, by its referrer host. Web Analytics keeps the referrer host but not
 * the page's query string, so the `?ref=` marker on Shipcast's links is not visible here. Mastodon
 * readers arrive from their own instance, which can be any host: those count as `other`.
 */
export function sourceOfReferrer(host: string | null | undefined): string {
  const h = (host ?? '').toLowerCase().replace(/^www\./, '');
  if (!h) return 'direct';
  if (h === 'bsky.app' || h.endsWith('.bsky.app')) return 'bluesky';
  if (h === 'dev.to') return 'devto';
  if (h === 'instagram.com' || h.endsWith('.instagram.com')) return 'instagram';
  if (h === 'reddit.com' || h.endsWith('.reddit.com')) return 'reddit';
  if (h === 'github.com') return 'github';
  if (/(^|\.)(google|bing|duckduckgo|ecosia)\./.test(h)) return 'search';
  if (h === 'mastodon.social' || h.endsWith('.mastodon.social')) return 'mastodon';
  return 'other';
}

/**
 * Cloudflare Web Analytics through the GraphQL Analytics API: page views of one path of the site,
 * grouped by referrer host, so the blog's numbers say which channel sent each visit. Needs an API
 * token with Account Analytics read; the site tag identifies the site.
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
    const out = new Map<string, PageVisits>(paths.map((p) => [p, { views: 0, bySource: {} }]));
    if (paths.length === 0) return out;
    const query = `query($account: String!, $filter: AccountRumPageloadEventsAdaptiveGroupsFilter_InputObject!) {
      viewer { accounts(filter: { accountTag: $account }) {
        rumPageloadEventsAdaptiveGroups(limit: 10000, filter: $filter) {
          count
          dimensions { requestPath refererHost }
        }
      } }
    }`;
    const response = await this.#fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.#token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables: { account: this.#account, filter: { siteTag: this.#siteTag, requestPath_in: [...paths], date_geq: since, date_leq: until } } }),
    });
    const body = await json<{
      data?: { viewer: { accounts: Array<{ rumPageloadEventsAdaptiveGroups: Array<{ count: number; dimensions: { requestPath?: string; refererHost?: string } }> }> } };
      errors?: Array<{ message: string }> | null;
    }>('Cloudflare', response, 'page visits');
    if (body.errors?.length) throw new ConnectorError('Cloudflare', body.errors.map((e) => e.message).join('; '));
    for (const group of body.data?.viewer.accounts[0]?.rumPageloadEventsAdaptiveGroups ?? []) {
      const visits = group.dimensions.requestPath === undefined ? undefined : out.get(group.dimensions.requestPath);
      if (!visits) continue;
      visits.views += group.count;
      const source = sourceOfReferrer(group.dimensions.refererHost);
      visits.bySource[source] = (visits.bySource[source] ?? 0) + group.count;
    }
    return out;
  }

  /** Views of `path` (e.g. `/en/claudio/`), or of the whole site without one, between two dates (YYYY-MM-DD, inclusive). */
  async pageVisits(path: string | undefined, since: string, until: string): Promise<PageVisits> {
    const query = `query($account: String!, $filter: AccountRumPageloadEventsAdaptiveGroupsFilter_InputObject!) {
      viewer { accounts(filter: { accountTag: $account }) {
        rumPageloadEventsAdaptiveGroups(limit: 1000, filter: $filter) {
          count
          dimensions { refererHost }
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
      data?: { viewer: { accounts: Array<{ rumPageloadEventsAdaptiveGroups: Array<{ count: number; dimensions: { refererHost?: string } }> }> } };
      errors?: Array<{ message: string }> | null;
    }>('Cloudflare', response, 'page visits');
    if (body.errors?.length) throw new ConnectorError('Cloudflare', body.errors.map((e) => e.message).join('; '));

    const groups = body.data?.viewer.accounts[0]?.rumPageloadEventsAdaptiveGroups ?? [];
    const bySource: Record<string, number> = {};
    let views = 0;
    for (const group of groups) {
      views += group.count;
      const source = sourceOfReferrer(group.dimensions.refererHost);
      bySource[source] = (bySource[source] ?? 0) + group.count;
    }
    return { views, bySource };
  }
}

/** Flattens page visits into metrics: `views`, and `views_<source>` per source. */
export function visitsToMetrics(visits: PageVisits): Metrics {
  const metrics: Metrics = { views: visits.views };
  for (const [source, count] of Object.entries(visits.bySource)) metrics[`views_${source}`] = count;
  return metrics;
}
