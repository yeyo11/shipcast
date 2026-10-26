import { checkProblem, ConnectorError, json, statsOf, type Check, type Metrics, type ProfileStats } from './http.ts';
import type { IndexStatus } from './search-console.ts';

const API = 'https://ssl.bing.com/webmaster/api.svc/json';

/** Bing's JSON dates are WCF dates, `/Date(1316213995266-0700)/`: milliseconds since the epoch */
export function wcfDate(value: string | undefined | null): Date | undefined {
  const ms = /\/Date\((-?\d+)/.exec(value ?? '')?.[1];
  if (ms === undefined) return undefined;
  const date = new Date(Number(ms));
  // Bing answers the year 1 for a page it has never crawled
  return date.getUTCFullYear() < 2000 ? undefined : date;
}

/**
 * Bing Webmaster Tools through its JSON API, with the user's API key (one per user, valid for every
 * site they verified): the clicks and impressions of a page, and when Bing discovered and last
 * crawled it. Bing does not say "indexed" the way Google's URL Inspection does, so a page Bing has
 * crawled is reported as such and nothing more.
 */
export class BingWebmaster {
  readonly #apiKey: string;
  readonly #site: string;
  readonly #fetch: typeof fetch;

  /** `site` as Bing Webmaster Tools lists it, e.g. `https://josegarrido.dev/` */
  constructor(options: { apiKey: string; site: string; fetch?: typeof fetch }) {
    this.#apiKey = options.apiKey;
    this.#site = options.site;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async #get<T>(method: string, params: Record<string, string>, what: string): Promise<T> {
    const query = new URLSearchParams({ ...params, apikey: this.#apiKey });
    const response = await this.#fetch(`${API}/${method}?${query}`, { headers: { accept: 'application/json' } });
    return (await json<{ d: T }>('Bing Webmaster', response, what)).d;
  }

  /** The key works and the site is one of the user's verified sites */
  async check(): Promise<Check> {
    try {
      const sites = await this.#get<Array<{ Url: string; IsVerified: boolean }>>('GetUserSites', {}, 'list the sites');
      const same = (url: string) => url.replace(/\/+$/, '').toLowerCase() === this.#site.replace(/\/+$/, '').toLowerCase();
      const site = sites.find((s) => same(s.Url));
      if (!site) throw new ConnectorError('Bing Webmaster', `${this.#site} is not among the sites of this API key's user (${sites.map((s) => s.Url).join(', ') || 'none'})`);
      if (!site.IsVerified) throw new ConnectorError('Bing Webmaster', `${this.#site} is added but not verified in Bing Webmaster Tools`);
      return { ok: true, account: `${site.Url} (verified)` };
    } catch (error) {
      return checkProblem(error);
    }
  }

  /** The site's clicks and impressions on Bing over the last 28 days, from its daily traffic: the numbers its card shows */
  async profileStats(): Promise<ProfileStats> {
    const days = await this.#get<Array<{ Date?: string; Clicks?: number; Impressions?: number }>>('GetRankAndTrafficStats', { siteUrl: this.#site }, 'site traffic');
    const since = Date.now() - 28 * 86_400_000;
    const recent = days.filter((d) => (wcfDate(d.Date)?.getTime() ?? 0) >= since);
    return statsOf({}, { clicks28d: recent.reduce((s, d) => s + (d.Clicks ?? 0), 0), impressions28d: recent.reduce((s, d) => s + (d.Impressions ?? 0), 0) });
  }

  /** Bing's clicks and impressions of one page, over the period Bing keeps (about six months) */
  async pageMetrics(url: string): Promise<Metrics> {
    const info = await this.#get<{ Clicks?: number; Impressions?: number }>('GetUrlTrafficInfo', { siteUrl: this.#site, url }, 'page traffic');
    return { clicks: info.Clicks ?? 0, impressions: info.Impressions ?? 0 };
  }

  /** Whether Bing has crawled one page, and when it found it */
  async inspect(url: string): Promise<IndexStatus> {
    const info = await this.#get<{ LastCrawledDate?: string; DiscoveryDate?: string; HttpStatus?: number }>('GetUrlInfo', { siteUrl: this.#site, url }, 'page info');
    const crawled = wcfDate(info.LastCrawledDate);
    const discovered = wcfDate(info.DiscoveryDate);
    const day = (d: Date) => d.toISOString().slice(0, 10);
    return {
      indexed: crawled !== undefined,
      coverage: crawled ? `Crawled on ${day(crawled)}` : discovered ? `Discovered on ${day(discovered)}, not crawled yet` : 'Not known to Bing yet',
      ...(crawled ? { lastCrawl: crawled.toISOString() } : {}),
    };
  }
}
