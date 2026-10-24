import { createSign } from 'node:crypto';
import { json, type Metrics } from './http.ts';

/** The fields of a Google service account key file that signing needs. */
export interface ServiceAccount {
  client_email: string;
  private_key: string;
}

const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';

/**
 * Google Search Console through its Search Analytics API, read-only: clicks, impressions, CTR and
 * average position of one page. Authenticated as a service account added as a user of the property,
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

  /** Search numbers of one page URL between two dates (YYYY-MM-DD); Google reports with ~2 days of delay. */
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
}
