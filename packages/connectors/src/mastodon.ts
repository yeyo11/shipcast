import { json, type Metrics, type Published } from './http.ts';

export interface MastodonPost {
  text: string;
  lang: string;
  /** An image attached to the post */
  image?: { bytes: Uint8Array; mimeType: string; filename: string; description: string };
  /** Mastodon refuses a second status with the same key, so a retried publish never posts twice */
  idempotencyKey: string;
}

/**
 * Mastodon through its REST API: a public status (with an optional image, described for screen
 * readers), and its favourites, boosts and replies read back from the status.
 */
export class Mastodon {
  readonly #instance: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;

  constructor(options: { instance: string; accessToken: string; fetch?: typeof fetch }) {
    this.#instance = options.instance.replace(/\/+$/, '');
    this.#token = options.accessToken;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async publish(post: MastodonPost): Promise<Published> {
    const auth = { authorization: `Bearer ${this.#token}` };
    const mediaIds: string[] = [];
    if (post.image) {
      const form = new FormData();
      form.append('file', new Blob([post.image.bytes], { type: post.image.mimeType }), post.image.filename);
      form.append('description', post.image.description);
      const uploaded = await this.#fetch(`${this.#instance}/api/v2/media`, { method: 'POST', headers: auth, body: form });
      mediaIds.push((await json<{ id: string }>('Mastodon', uploaded, 'upload the image')).id);
    }
    const response = await this.#fetch(`${this.#instance}/api/v1/statuses`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json', 'idempotency-key': post.idempotencyKey },
      body: JSON.stringify({ status: post.text, language: post.lang, visibility: 'public', media_ids: mediaIds }),
    });
    const created = await json<{ id: string; url: string }>('Mastodon', response, 'publish');
    return { externalId: created.id, url: created.url };
  }

  async metrics(externalId: string): Promise<Metrics> {
    const response = await this.#fetch(`${this.#instance}/api/v1/statuses/${externalId}`, {
      headers: { authorization: `Bearer ${this.#token}` },
    });
    const status = await json<{ favourites_count: number; reblogs_count: number; replies_count: number }>('Mastodon', response, 'metrics');
    return { favourites: status.favourites_count, boosts: status.reblogs_count, replies: status.replies_count };
  }
}
