import { checkProblem, ConnectorError, expectOk, json, okCheck, type Check, type Deletable, type Published } from './http.ts';

export interface LinkedInPost {
  /** The post's own text (LinkedIn calls it commentary), at most 3000 characters */
  text: string;
  /** The article it shares: the Posts API does not read the page, so its title and description travel with it */
  article: { url: string; title: string; description: string; thumbnail?: { bytes: Uint8Array; mimeType: string } };
}

export interface LinkedInOptions {
  /** The member's id: OpenID Connect's `sub`, which makes the author `urn:li:person:<id>` */
  personId: string;
  accessToken: string;
  /** When the token stops working, ISO; LinkedIn gives most apps no refresh token */
  expiresAt?: string;
  fetch?: typeof fetch;
  /** The Posts API version, YYYYMM; LinkedIn sunsets each one about a year after it ships */
  version?: string;
  now?: () => number;
}

/** A version LinkedIn ships monthly and supports for a year; the newest documented on 2026-10-25 is 202610 */
export const LINKEDIN_VERSION = '202609';

/**
 * LinkedIn on the owner's personal profile, with `w_member_social` ("Share on LinkedIn"): an article
 * post through the Posts API (`/rest/posts`, which replaced ugcPosts), its thumbnail uploaded through
 * the Images API first, and its delete. Reading a member's posts, comments or numbers needs the
 * Community Management API (`r_member_social`), which LinkedIn grants only to approved companies, so
 * there are no metrics and no comments here.
 */
export class LinkedIn implements Deletable {
  readonly #person: string;
  readonly #token: string;
  readonly #expiresAt: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #version: string;
  readonly #now: () => number;

  constructor(options: LinkedInOptions) {
    this.#person = options.personId;
    this.#token = options.accessToken;
    this.#expiresAt = options.expiresAt;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#version = options.version ?? LINKEDIN_VERSION;
    this.#now = options.now ?? Date.now;
  }

  get author(): string {
    return `urn:li:person:${this.#person}`;
  }

  #headers(extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: `Bearer ${this.#token}`, 'linkedin-version': this.#version, 'x-restli-protocol-version': '2.0.0', ...extra };
  }

  #expired(): boolean {
    return this.#expiresAt !== undefined && Date.parse(this.#expiresAt) <= this.#now();
  }

  /** The thumbnail as an image URN: initialise the upload, then PUT the bytes where LinkedIn says */
  async #upload(image: { bytes: Uint8Array; mimeType: string }): Promise<string> {
    const init = await this.#fetch('https://api.linkedin.com/rest/images?action=initializeUpload', {
      method: 'POST',
      headers: this.#headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ initializeUploadRequest: { owner: this.author } }),
    });
    const { value } = await json<{ value: { uploadUrl: string; image: string } }>('LinkedIn', init, 'start the image upload');
    const put = await this.#fetch(value.uploadUrl, { method: 'PUT', headers: { authorization: `Bearer ${this.#token}`, 'content-type': image.mimeType }, body: new Blob([image.bytes as Uint8Array<ArrayBuffer>], { type: image.mimeType }) });
    await expectOk('LinkedIn', put, 'upload the image');
    return value.image;
  }

  async publish(post: LinkedInPost): Promise<Published> {
    if (this.#expired()) throw new ConnectorError('LinkedIn', 'the token has expired: connect the account again from Channels', 401, false);
    // A thumbnail that fails to upload costs the card its picture, never the post
    const thumbnail = post.article.thumbnail ? await this.#upload(post.article.thumbnail).catch(() => undefined) : undefined;
    const response = await this.#fetch('https://api.linkedin.com/rest/posts', {
      method: 'POST',
      headers: this.#headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        author: this.author,
        commentary: escapeLittle(post.text),
        visibility: 'PUBLIC',
        distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
        content: { article: { source: post.article.url, title: post.article.title, description: post.article.description, ...(thumbnail && { thumbnail }) } },
        lifecycleState: 'PUBLISHED',
        isReshareDisabledByAuthor: false,
      }),
    });
    await expectOk('LinkedIn', response, 'publish');
    const urn = response.headers.get('x-restli-id');
    // Created but unnamed: retrying would post it twice
    if (!urn) throw new ConnectorError('LinkedIn', 'the post was created but LinkedIn returned no id for it', response.status, false);
    return { externalId: urn, url: `https://www.linkedin.com/feed/update/${urn}/` };
  }

  /** Idempotent on LinkedIn's side: deleting a deleted post answers 204 too */
  async delete(externalId: string): Promise<void> {
    const response = await this.#fetch(`https://api.linkedin.com/rest/posts/${encodeURIComponent(externalId)}`, {
      method: 'DELETE',
      headers: this.#headers({ 'x-restli-method': 'DELETE' }),
    });
    await expectOk('LinkedIn', response, 'delete');
  }

  /** The member behind the token, from OpenID Connect's userinfo, which `openid profile` grants */
  async check(): Promise<Check> {
    if (this.#expired()) return { ok: false, problem: 'LinkedIn’s token has expired (they last 60 days): connect the account again' };
    try {
      const me = await json<{ sub: string; name?: string; picture?: string }>(
        'LinkedIn',
        await this.#fetch('https://api.linkedin.com/v2/userinfo', { headers: { authorization: `Bearer ${this.#token}` } }),
        'check',
      );
      if (me.sub !== this.#person) return { ok: false, problem: `the token belongs to ${me.name ?? me.sub}, not to the account ${this.#person}` };
      return okCheck(me.name ?? me.sub, { avatarUrl: me.picture, displayName: me.name });
    } catch (error) {
      return checkProblem(error);
    }
  }
}

/**
 * The commentary is in LinkedIn's "little" text format, where these characters are markup: left
 * bare, a parenthesis or a bracket can cut the post short. Escaped, they read as written; a
 * hashtag is left as it is, since LinkedIn makes `#word` a hashtag on its own.
 */
export function escapeLittle(text: string): string {
  return text.replace(/[\\|{}@[\]()<>*_~]/g, (c) => `\\${c}`);
}
