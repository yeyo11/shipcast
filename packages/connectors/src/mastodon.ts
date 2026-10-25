import { checkProblem, expectOk, json, okCheck, statsOf, type Check, type Deletable, type Editable, type Metrics, type ProfileStats, type Published } from './http.ts';

interface MastodonAccount {
  acct: string;
  display_name?: string;
  avatar?: string;
  followers_count?: number;
  following_count?: number;
  statuses_count?: number;
}

export interface MastodonPost {
  text: string;
  lang: string;
  /** An image attached to the post */
  image?: { bytes: Uint8Array; mimeType: string; filename: string; description: string };
  /** Mastodon refuses a second status with the same key, so a retried publish never posts twice */
  idempotencyKey: string;
}

export interface MastodonEdit {
  /** The status's new text; left out, the text it has is kept */
  text?: string;
  /** A new image in place of the one it has; left out, its media stay */
  image?: MastodonPost['image'];
}

/**
 * Mastodon through its REST API: a public status (with an optional image, described for screen
 * readers), and its favourites, boosts and replies read back from the status. A status can be edited
 * (text and media) and deleted.
 */
export class Mastodon implements Editable<MastodonEdit>, Deletable {
  readonly #instance: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;

  constructor(options: { instance: string; accessToken: string; fetch?: typeof fetch }) {
    this.#instance = options.instance.replace(/\/+$/, '');
    this.#token = options.accessToken;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async #upload(image: NonNullable<MastodonPost['image']>): Promise<string> {
    const form = new FormData();
    form.append('file', new Blob([image.bytes as Uint8Array<ArrayBuffer>], { type: image.mimeType }), image.filename);
    form.append('description', image.description);
    const uploaded = await this.#fetch(`${this.#instance}/api/v2/media`, { method: 'POST', headers: { authorization: `Bearer ${this.#token}` }, body: form });
    return (await json<{ id: string }>('Mastodon', uploaded, 'upload the image')).id;
  }

  async publish(post: MastodonPost): Promise<Published> {
    const auth = { authorization: `Bearer ${this.#token}` };
    const mediaIds: string[] = [];
    if (post.image) mediaIds.push(await this.#upload(post.image));
    const response = await this.#fetch(`${this.#instance}/api/v1/statuses`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json', 'idempotency-key': post.idempotencyKey },
      body: JSON.stringify({ status: post.text, language: post.lang, visibility: 'public', media_ids: mediaIds }),
    });
    const created = await json<{ id: string; url: string }>('Mastodon', response, 'publish');
    return { externalId: created.id, url: created.url };
  }

  /**
   * PUT replaces the status as a whole, so what is not changing is read first and sent back: its
   * media ids and language, and its plain source text when only the image changes (the status itself
   * carries the text as rendered HTML).
   */
  async edit(externalId: string, edit: MastodonEdit): Promise<void> {
    const auth = { authorization: `Bearer ${this.#token}` };
    const id = encodeURIComponent(externalId);
    const current = await json<{ language?: string | null; media_attachments?: Array<{ id: string }> }>(
      'Mastodon',
      await this.#fetch(`${this.#instance}/api/v1/statuses/${id}`, { headers: auth }),
      'read the status',
    );
    const text =
      edit.text ??
      (await json<{ text: string }>('Mastodon', await this.#fetch(`${this.#instance}/api/v1/statuses/${id}/source`, { headers: auth }), 'read the status text')).text;
    const mediaIds = edit.image ? [await this.#upload(edit.image)] : (current.media_attachments ?? []).map((m) => m.id);
    const response = await this.#fetch(`${this.#instance}/api/v1/statuses/${id}`, {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ status: text, media_ids: mediaIds, ...(current.language ? { language: current.language } : {}) }),
    });
    await expectOk('Mastodon', response, 'edit');
  }

  async delete(externalId: string): Promise<void> {
    const response = await this.#fetch(`${this.#instance}/api/v1/statuses/${encodeURIComponent(externalId)}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${this.#token}` },
    });
    await expectOk('Mastodon', response, 'delete');
  }

  async #me(what: string): Promise<MastodonAccount> {
    const response = await this.#fetch(`${this.#instance}/api/v1/accounts/verify_credentials`, { headers: { authorization: `Bearer ${this.#token}` } });
    return json<MastodonAccount>('Mastodon', response, what);
  }

  /** The token's account; also proves the token may read, which the metrics need */
  async check(): Promise<Check> {
    try {
      const me = await this.#me('check');
      return okCheck(`@${me.acct}@${new URL(this.#instance).host}`, { avatarUrl: me.avatar, displayName: me.display_name });
    } catch (error) {
      return checkProblem(error);
    }
  }

  async profileStats(): Promise<ProfileStats> {
    const me = await this.#me('read the profile');
    return statsOf({ followers: me.followers_count, following: me.following_count, posts: me.statuses_count });
  }

  async metrics(externalId: string): Promise<Metrics> {
    const response = await this.#fetch(`${this.#instance}/api/v1/statuses/${externalId}`, {
      headers: { authorization: `Bearer ${this.#token}` },
    });
    const status = await json<{ favourites_count: number; reblogs_count: number; replies_count: number }>('Mastodon', response, 'metrics');
    return { favourites: status.favourites_count, boosts: status.reblogs_count, replies: status.replies_count };
  }
}
