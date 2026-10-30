import { checkProblem, ConnectorError, json, okCheck, statsOf, type Check, type ProfileStats } from './http.ts';

/** One source's share of a campaign over a period, as Umami counts it */
export interface SourceVisits {
  /** Page views */
  views: number;
  /** Visits: a visitor's pageviews within one sitting */
  visits: number;
  /** Unique visitors over the period: not a sum of days */
  visitors: number;
}

/** A campaign's visits by `utm_source`: over the period, and day by day (UTC days) */
export interface CampaignVisits {
  bySource: Record<string, SourceVisits>;
  /** Each source's page views and unique visitors of each day, keyed by YYYY-MM-DD */
  days: Record<string, Record<string, { views: number; visitors: number }>>;
}

const DAY_MS = 86_400_000;

/** A row of `/metrics/expanded`: one value of the dimension asked for, with its counts */
interface ExpandedRow {
  name: string | null;
  pageviews?: number;
  visits?: number;
  visitors?: number;
}

/** A point of a `/pageviews` series: its time bucket and its count */
interface Point {
  x: string;
  y: number;
}

/**
 * Umami's read API (docs.umami.is, Umami v3, read on 2026-10-30): the blog's visits by the UTM tags
 * every published link carries (docs/tracking.md). Unlike Cloudflare Web Analytics, Umami keeps the
 * landing page's query string, so a visit is credited to its `utm_source` and `utm_campaign` rather
 * than guessed from its referrer. Self-hosted: an API key (`umami_…`, Settings → API keys) or, on an
 * instance without them, a user's name and password exchanged for a token at `/api/auth/login`.
 */
export class UmamiAnalytics {
  readonly #api: string;
  readonly #websiteId: string;
  readonly #apiKey: string | undefined;
  readonly #login: { username: string; password: string } | undefined;
  readonly #fetch: typeof fetch;
  #token: string | undefined;

  constructor(options: { url: string; websiteId: string; apiKey?: string; username?: string; password?: string; fetch?: typeof fetch }) {
    const base = options.url.trim().replace(/\/+$/, '');
    // The instance's address or its API's: a self-hosted API is under /api, Umami Cloud's under /v1
    this.#api = /\/(api|v1)$/.test(base) ? base : `${base}/api`;
    this.#websiteId = options.websiteId;
    this.#apiKey = options.apiKey || undefined;
    this.#login = !this.#apiKey && options.username && options.password ? { username: options.username, password: options.password } : undefined;
    if (!this.#apiKey && !this.#login) throw new ConnectorError('Umami', 'needs an API key, or a username and a password', undefined, false);
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  /** The website by its id: proves the address, the credential and the website together */
  async check(): Promise<Check> {
    try {
      const site = await this.#get<{ name?: string; domain?: string }>(`/websites/${this.#websiteId}`, {}, 'website');
      return okCheck(`${site.name ?? this.#websiteId}${site.domain ? ` (${site.domain})` : ''} on ${new URL(this.#api).host}`);
    } catch (error) {
      return checkProblem(error);
    }
  }

  /** The site's visits over the last seven days, every page: the number its card shows */
  async profileStats(now = new Date()): Promise<ProfileStats> {
    const stats = await this.#get<{ visits?: number }>(`/websites/${this.#websiteId}/stats`, { startAt: String(now.getTime() - 7 * DAY_MS), endAt: String(now.getTime()) }, 'stats');
    return statsOf({}, { visits7d: stats.visits });
  }

  /**
   * A campaign's visits from each source between two dates (YYYY-MM-DD, inclusive, UTC): the totals of
   * every source in one call, then each source's days in one call each. A source with no visits in
   * the period is not in Umami's answer, so it costs nothing.
   */
  async campaignVisits(campaign: string, since: string, until: string): Promise<CampaignVisits> {
    const range = { startAt: String(Date.parse(`${since}T00:00:00Z`)), endAt: String(Date.parse(`${until}T00:00:00Z`) + DAY_MS - 1) };
    const rows = await this.#get<ExpandedRow[]>(`/websites/${this.#websiteId}/metrics/expanded`, { ...range, type: 'utmSource', utmCampaign: campaign }, 'visits by source');
    const bySource: CampaignVisits['bySource'] = {};
    for (const row of rows) {
      if (!row.name) continue;
      bySource[row.name] = { views: row.pageviews ?? 0, visits: row.visits ?? 0, visitors: row.visitors ?? 0 };
    }
    const days: CampaignVisits['days'] = {};
    await Promise.all(
      Object.keys(bySource).map(async (source) => {
        const series = await this.#get<{ pageviews?: Point[]; sessions?: Point[] }>(
          `/websites/${this.#websiteId}/pageviews`,
          { ...range, unit: 'day', timezone: 'UTC', utmCampaign: campaign, utmSource: source },
          'visits by day',
        );
        const of = (days[source] = {} as Record<string, { views: number; visitors: number }>);
        // A bucket is the day's start in the time zone asked for: `2026-10-25 00:00:00` or ISO
        for (const p of series.pageviews ?? []) (of[p.x.slice(0, 10)] ??= { views: 0, visitors: 0 }).views += p.y;
        // Umami's `sessions` series is what its own chart shows as visitors
        for (const p of series.sessions ?? []) (of[p.x.slice(0, 10)] ??= { views: 0, visitors: 0 }).visitors += p.y;
      }),
    );
    return { bySource, days };
  }

  async #get<T>(path: string, params: Record<string, string>, what: string): Promise<T> {
    const url = new URL(`${this.#api}${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const ask = async () => this.#fetch(url, { headers: { accept: 'application/json', authorization: `Bearer ${await this.#bearer()}` } });
    let response = await ask();
    // A login token can expire between reads: sign in again once
    if (response.status === 401 && this.#login && this.#token) {
      this.#token = undefined;
      response = await ask();
    }
    return json<T>('Umami', response, what);
  }

  async #bearer(): Promise<string> {
    if (this.#apiKey) return this.#apiKey;
    if (this.#token) return this.#token;
    const response = await this.#fetch(`${this.#api}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(this.#login),
    });
    const body = await json<{ token?: string; requiresTwoFactor?: boolean }>('Umami', response, 'login');
    if (body.requiresTwoFactor) throw new ConnectorError('Umami', 'the user has two-factor sign-in: use an API key instead', undefined, false);
    if (!body.token) throw new ConnectorError('Umami', 'login: no token in the answer', undefined, false);
    this.#token = body.token;
    return body.token;
  }
}
