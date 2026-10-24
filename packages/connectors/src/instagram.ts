import { ConnectorError, json, type Metrics, type Published } from './http.ts';

export interface InstagramPost {
  caption: string;
  /** A public URL Instagram fetches when the container is created: a JPEG, or an MP4 for a Reel */
  media: { kind: 'image'; url: string } | { kind: 'reel'; url: string };
}

export interface InstagramOptions {
  userId: string;
  accessToken: string;
  fetch?: typeof fetch;
  /** The Graph API version; Meta retires versions about two years after release */
  version?: string;
  pollMs?: number;
  /** How long Instagram may take to process a Reel */
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Instagram through the Instagram API with Instagram Login: a media container from a public URL,
 * waited on until Instagram has fetched and processed it (a Reel takes a while), then published;
 * its insights read back for the metrics. The long-lived token is refreshed with `refreshToken`.
 */
export class Instagram {
  readonly #user: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #base: string;
  readonly #pollMs: number;
  readonly #timeoutMs: number;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(options: InstagramOptions) {
    this.#user = options.userId;
    this.#token = options.accessToken;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#base = `https://graph.instagram.com/${options.version ?? 'v25.0'}`;
    this.#pollMs = options.pollMs ?? 10_000;
    this.#timeoutMs = options.timeoutMs ?? 10 * 60_000;
    this.#sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async #post<T>(path: string, params: Record<string, string>, what: string): Promise<T> {
    const response = await this.#fetch(`${this.#base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...params, access_token: this.#token }),
    });
    return json<T>('Instagram', response, what);
  }

  async #get<T>(path: string, params: Record<string, string>, what: string): Promise<T> {
    const query = new URLSearchParams({ ...params, access_token: this.#token });
    return json<T>('Instagram', await this.#fetch(`${this.#base}${path}?${query}`), what);
  }

  async publish(post: InstagramPost): Promise<Published> {
    const media: Record<string, string> =
      post.media.kind === 'image'
        ? { image_url: post.media.url }
        : { media_type: 'REELS', video_url: post.media.url, share_to_feed: 'true' };
    const container = await this.#post<{ id: string }>(`/${this.#user}/media`, { ...media, caption: post.caption }, 'create the media');

    // A container is invisible until it is published, and publishing before Instagram has
    // processed the media fails; images are usually ready at once, Reels take a minute or more
    const deadline = Date.now() + this.#timeoutMs;
    for (;;) {
      const { status_code: status } = await this.#get<{ status_code: string }>(`/${container.id}`, { fields: 'status_code' }, 'check the media');
      if (status === 'FINISHED') break;
      if (status === 'ERROR' || status === 'EXPIRED') {
        throw new ConnectorError('Instagram', `the media could not be processed (${status}); check that its URL is public`);
      }
      if (Date.now() > deadline) throw new ConnectorError('Instagram', `the media was still ${status} after ${this.#timeoutMs} ms`);
      await this.#sleep(this.#pollMs);
    }

    const published = await this.#post<{ id: string }>(`/${this.#user}/media_publish`, { creation_id: container.id }, 'publish');
    const { permalink } = await this.#get<{ permalink: string }>(`/${published.id}`, { fields: 'permalink' }, 'read the permalink');
    return { externalId: published.id, url: permalink };
  }

  /** The metrics Meta offers on a post; `views` replaced impressions in 2025. */
  async metrics(externalId: string): Promise<Metrics> {
    const { data } = await this.#get<{ data: Array<{ name: string; values?: Array<{ value: number }>; total_value?: { value: number } }> }>(
      `/${externalId}/insights`,
      { metric: 'views,reach,likes,comments,saved,shares' },
      'metrics',
    );
    const out: Metrics = {};
    for (const metric of data) out[metric.name] = metric.total_value?.value ?? metric.values?.[0]?.value ?? 0;
    return out;
  }

  /** Swaps the long-lived token for a fresh one (valid 60 more days); allowed once it is 24 h old. */
  async refreshToken(): Promise<{ accessToken: string; expiresIn: number }> {
    const query = new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: this.#token });
    const response = await this.#fetch(`https://graph.instagram.com/refresh_access_token?${query}`);
    const refreshed = await json<{ access_token: string; expires_in: number }>('Instagram', response, 'refresh the token');
    return { accessToken: refreshed.access_token, expiresIn: refreshed.expires_in };
  }
}
