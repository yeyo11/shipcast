import { createSign } from 'node:crypto';
import { checkProblem, json, statsOf, type Check, type Metrics, type ProfileStats } from './http.ts';

/** The fields of a Google service account key file that signing needs. */
export interface ServiceAccount {
  client_email: string;
  private_key: string;
}

// Not the read-only scope: resubmitting the sitemap is a write. The service account still only
// reaches the properties it was added to.
const SCOPE = 'https://www.googleapis.com/auth/webmasters';

/** Whether Google has a page in its index, from the URL Inspection API */
export interface IndexStatus {
  indexed: boolean;
  /** Google's own words: "Submitted and indexed", "Discovered - currently not indexed", "URL is unknown to Google"… */
  coverage: string;
  lastCrawl?: string;
  /**
   * The URL Google chose as canonical, absent until it indexes the page. Search Console credits
   * clicks and impressions to it: when it is not the article's own, the article's numbers miss them
   */
  googleCanonical?: string;
  /** The canonical the page declares */
  userCanonical?: string;
}

/**
 * Google Search Console: clicks, impressions, CTR and average position of one page (Search
 * Analytics), whether a page is indexed (URL Inspection), and resubmitting the sitemap. Authenticated as a service account added as a user of the property,
 * with a JWT signed here (node:crypto) instead of a Google client library.
 */
export class SearchConsole {
  readonly #account: ServiceAccount;
  readonly #property: string;
  readonly #fetch: typeof fetch;
  #token: { value: string; expires: number } | undefined;

  /** `property` is how Search Console names it: `sc-domain:josegarrido.dev` for a domain property */
  constructor(options: { serviceAccount: ServiceAccount; property: string; fetch?: typeof fetch }) {
    this.#account = options.serviceAccount;
    this.#property = options.property;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async #accessToken(): Promise<string> {
    if (this.#token && this.#token.expires > Date.now() + 60_000) return this.#token.value;
    const now = Math.floor(Date.now() / 1000);
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
      iss: this.#account.client_email,
      scope: SCOPE,
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    })}`;
    const signature = createSign('RSA-SHA256').update(unsigned).sign(this.#account.private_key).toString('base64url');
    const response = await this.#fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }),
    });
    const token = await json<{ access_token: string; expires_in: number }>('Search Console', response, 'sign in');
    this.#token = { value: token.access_token, expires: Date.now() + token.expires_in * 1000 };
    return token.access_token;
  }

  /** Signs in and reads the property, which fails unless the service account was added as its user */
  async check(): Promise<Check> {
    try {
      const response = await this.#fetch(`https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(this.#property)}`, {
        headers: { authorization: `Bearer ${await this.#accessToken()}` },
      });
      const site = await json<{ permissionLevel: string }>('Search Console', response, 'check');
      return { ok: true, account: `${this.#account.client_email} on ${this.#property} (${site.permissionLevel})` };
    } catch (error) {
      return checkProblem(error);
    }
  }

  /**
   * The property's clicks and impressions over the last 28 days, every page, ending two days back
   * since Google reports late: the numbers its card shows
   */
  async profileStats(): Promise<ProfileStats> {
    const day = (back: number) => new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 10);
    const response = await this.#fetch(`https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(this.#property)}/searchAnalytics/query`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await this.#accessToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ startDate: day(29), endDate: day(2) }),
    });
    const { rows } = await json<{ rows?: Array<{ clicks: number; impressions: number }> }>('Search Console', response, 'site metrics');
    return statsOf({}, { clicks28d: rows?.[0]?.clicks ?? 0, impressions28d: rows?.[0]?.impressions ?? 0 });
  }

  /**
   * Search numbers of one page URL between two dates (YYYY-MM-DD): clicks, impressions, CTR and
   * average position. Final data only, which Google has two to three days after the search.
   */
  async pageMetrics(url: string, since: string, until: string): Promise<Metrics> {
    const response = await this.#fetch(
      `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(this.#property)}/searchAnalytics/query`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${await this.#accessToken()}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          startDate: since,
          endDate: until,
          dimensions: ['page'],
          dimensionFilterGroups: [{ filters: [{ dimension: 'page', operator: 'equals', expression: url }] }],
        }),
      },
    );
    const { rows } = await json<{ rows?: Array<{ clicks: number; impressions: number; ctr: number; position: number }> }>(
      'Search Console',
      response,
      'page metrics',
    );
    const row = rows?.[0];
    return row
      ? { clicks: row.clicks, impressions: row.impressions, ctr: row.ctr, position: row.position }
      : { clicks: 0, impressions: 0 };
  }

  /** Whether Google has indexed one URL of the property; the API allows 2,000 inspections a day */
  async inspect(url: string): Promise<IndexStatus> {
    const response = await this.#fetch('https://searchconsole.googleapis.com/v1/urlInspection/index:inspect', {
      method: 'POST',
      headers: { authorization: `Bearer ${await this.#accessToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ inspectionUrl: url, siteUrl: this.#property }),
    });
    const { inspectionResult } = await json<{
      inspectionResult?: { indexStatusResult?: { verdict?: string; coverageState?: string; lastCrawlTime?: string; googleCanonical?: string; userCanonical?: string } };
    }>('Search Console', response, 'inspect a URL');
    const status = inspectionResult?.indexStatusResult;
    return {
      indexed: status?.verdict === 'PASS',
      coverage: status?.coverageState ?? 'Unknown',
      ...(status?.lastCrawlTime ? { lastCrawl: status.lastCrawlTime } : {}),
      ...(status?.googleCanonical ? { googleCanonical: status.googleCanonical } : {}),
      ...(status?.userCanonical ? { userCanonical: status.userCanonical } : {}),
    };
  }

  /**
   * Asks Google to read the sitemap again. Google read it once, when it was added, and otherwise
   * comes back on its own schedule, which leaves a new article unknown to it for days.
   */
  async submitSitemap(sitemapUrl: string): Promise<void> {
    const response = await this.#fetch(
      `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(this.#property)}/sitemaps/${encodeURIComponent(sitemapUrl)}`,
      { method: 'PUT', headers: { authorization: `Bearer ${await this.#accessToken()}` } },
    );
    if (!response.ok) await json('Search Console', response, 'submit the sitemap');
  }
}
