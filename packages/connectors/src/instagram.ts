import {
  checkProblem,
  secretTag,
  type IdentityCache,
  ConnectorError,
  json,
  okCheck,
  statsOf,
  type Check,
  type Comment,
  type CommentReader,
  type Metrics,
  type ProfileStats,
  type Published,
  type Replier,
  type ReplyTarget,
  type SentReply,
} from './http.ts';

/** A public URL Instagram fetches when the container is created: a JPEG, or an MP4 */
export type InstagramMedia = { kind: 'image' | 'video'; url: string };

export interface InstagramPost {
  caption: string;
  /** One piece is a single post (a video becomes a Reel); two to twenty make a carousel */
  media: InstagramMedia[];
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
  /** Where the account's username is kept between runs */
  cache?: IdentityCache;
}

/**
 * Instagram through the Instagram API with Instagram Login: a media container from a public URL,
 * waited on until Instagram has fetched and processed it (a Reel takes a while), then published;
 * its insights read back for the metrics. The long-lived token is refreshed with `refreshToken`.
 * Neither `edit` nor `delete`: the Graph API changes no caption of a published post and deletes no
 * post, only comments.
 */
export class Instagram implements CommentReader, Replier {
  readonly #user: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #base: string;
  readonly #pollMs: number;
  readonly #timeoutMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  #username: Promise<string> | undefined;
  readonly #cache: IdentityCache | undefined;

  constructor(options: InstagramOptions) {
    this.#user = options.userId;
    this.#token = options.accessToken;
    this.#cache = options.cache;
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

  /**
   * A container is invisible until it is published, and publishing before Instagram has processed
   * its media fails; images are usually ready at once, videos take a minute or more.
   */
  async #ready(containerId: string): Promise<void> {
    const deadline = Date.now() + this.#timeoutMs;
    for (;;) {
      const { status_code: status } = await this.#get<{ status_code: string }>(`/${containerId}`, { fields: 'status_code' }, 'check the media');
      if (status === 'FINISHED') return;
      if (status === 'ERROR' || status === 'EXPIRED') {
        throw new ConnectorError('Instagram', `the media could not be processed (${status}); check that its URL is public`);
      }
      if (Date.now() > deadline) throw new ConnectorError('Instagram', `the media was still ${status} after ${this.#timeoutMs} ms`);
      await this.#sleep(this.#pollMs);
    }
  }

  async #container(params: Record<string, string>, what: string): Promise<string> {
    const { id } = await this.#post<{ id: string }>(`/${this.#user}/media`, params, what);
    await this.#ready(id);
    return id;
  }

  async #publishContainer(containerId: string): Promise<Published> {
    const published = await this.#post<{ id: string }>(`/${this.#user}/media_publish`, { creation_id: containerId }, 'publish');
    const { permalink } = await this.#get<{ permalink: string }>(`/${published.id}`, { fields: 'permalink' }, 'read the permalink');
    return { externalId: published.id, url: permalink };
  }

  async publish(post: InstagramPost): Promise<Published> {
    const [first, ...rest] = post.media;
    if (!first) throw new ConnectorError('Instagram', 'a post needs at least one image or video');
    if (rest.length === 0) {
      const media: Record<string, string> = first.kind === 'image' ? { image_url: first.url } : { media_type: 'REELS', video_url: first.url, share_to_feed: 'true' };
      return this.#publishContainer(await this.#container({ ...media, caption: post.caption }, 'create the media'));
    }
    if (post.media.length > 20) throw new ConnectorError('Instagram', 'a carousel takes at most 20 pieces');
    // Each piece is a container of its own, then one carousel container lists them in order
    const children: string[] = [];
    for (const item of post.media) {
      const media: Record<string, string> = item.kind === 'image' ? { image_url: item.url } : { media_type: 'VIDEO', video_url: item.url };
      children.push(await this.#container({ ...media, is_carousel_item: 'true' }, `create carousel piece ${children.length + 1}`));
    }
    const carousel = await this.#container({ media_type: 'CAROUSEL', children: children.join(','), caption: post.caption }, 'create the carousel');
    return this.#publishContainer(carousel);
  }

  /** A story: one image or video, shown for 24 hours. The API cannot add stickers, so no link. */
  async publishStory(media: InstagramMedia): Promise<Published> {
    const params: Record<string, string> = media.kind === 'image' ? { image_url: media.url } : { video_url: media.url };
    return this.#publishContainer(await this.#container({ ...params, media_type: 'STORIES' }, 'create the story'));
  }

  /** A comment on one of the account's own posts; needs `instagram_business_manage_comments`. */
  async comment(mediaId: string, message: string): Promise<{ id: string }> {
    return this.#post<{ id: string }>(`/${mediaId}/comments`, { message }, 'comment');
  }

  /** The account's own username, read once: what tells the owner's replies from the others' */
  async #ownName(): Promise<string> {
    const load = () => this.#get<{ username: string }>('/me', { fields: 'username' }, 'read the account').then((me) => me.username);
    // Kept a day between runs, so /me is not asked hourly
    this.#username ??= (this.#cache ? this.#cache.remember(`instagram-me:${secretTag(this.#token)}`, 86_400, load) : load()).then(
      (name) => name,
      (error: unknown) => {
        this.#username = undefined;
        throw error;
      },
    );
    return this.#username;
  }

  /**
   * Graph API refusals for a missing permission (#10, #200) and a token without the comments scope
   * read as a code, never as what to do; this says it.
   */
  #permission(error: unknown): unknown {
    if (error instanceof ConnectorError && /"code"\s*:\s*(10|200|3)\b|permission/i.test(error.message)) {
      return new ConnectorError('Instagram', 'the account was connected without instagram_business_manage_comments: connect it again and allow comments', 403, false);
    }
    return error;
  }

  /**
   * The comments under a post with their replies, a page of 50 at a time (at most ten pages). Needs
   * `instagram_business_manage_comments`; without it the Graph API refuses, and this says so.
   */
  async comments(mediaId: string): Promise<Comment[]> {
    type IgComment = { id: string; text?: string; timestamp: string; username?: string; from?: { id: string; username: string } };
    type Page = { data: Array<IgComment & { replies?: { data: IgComment[] } }>; paging?: { cursors?: { after?: string }; next?: string } };
    const own = await this.#ownName().catch((error: unknown) => {
      throw this.#permission(error);
    });
    const out: Comment[] = [];
    const add = (c: IgComment, parent?: string) => {
      const username = c.username ?? c.from?.username ?? 'unknown';
      out.push({ externalId: c.id, author: { handle: `@${username}` }, text: c.text ?? '', createdAt: c.timestamp, ...(parent && { inReplyTo: parent }), own: username === own });
    };
    let after: string | undefined;
    for (let page = 0; page < 10; page++) {
      let answer: Page;
      try {
        answer = await this.#get<Page>(
          `/${mediaId}/comments`,
          { fields: 'id,text,timestamp,username,from,replies{id,text,timestamp,username,from}', limit: '50', ...(after && { after }) },
          'read the comments',
        );
      } catch (error) {
        throw this.#permission(error);
      }
      for (const comment of answer.data) {
        add(comment);
        for (const reply of comment.replies?.data ?? []) add(reply, comment.id);
      }
      after = answer.paging?.next ? answer.paging.cursors?.after : undefined;
      if (!after) break;
    }
    return out;
  }

  /**
   * Each of the account's media with how many comments it has (replies included), a hundred a page,
   * five pages at most: one call that says which posts have comments to read, since Instagram has
   * no feed of them to poll.
   */
  async commentCounts(): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    let after: string | undefined;
    for (let page = 0; page < 5; page++) {
      let answer: { data: Array<{ id: string; comments_count?: number }>; paging?: { cursors?: { after?: string }; next?: string } };
      try {
        answer = await this.#get(`/${this.#user}/media`, { fields: 'id,comments_count', limit: '100', ...(after && { after }) }, 'count the comments');
      } catch (error) {
        throw this.#permission(error);
      }
      for (const m of answer.data) out.set(m.id, m.comments_count ?? 0);
      after = answer.paging?.next ? answer.paging.cursors?.after : undefined;
      if (!after) break;
    }
    return out;
  }

  /** A reply under a comment; Instagram threads it and notifies its author. Comments have no address of their own. */
  async reply(target: ReplyTarget, text: string): Promise<SentReply> {
    try {
      const { id } = await this.#post<{ id: string }>(`/${target.commentExternalId}/replies`, { message: text }, 'reply');
      return { externalId: id };
    } catch (error) {
      throw this.#permission(error);
    }
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

  /**
   * How many followers are online at each hour of the day, summed over the days Meta returns (it
   * keeps the last 30): `online_followers`, under `instagram_business_manage_insights`, which the
   * connector already asks for. Undefined when Meta gives nothing, as it does below 100 followers.
   * Meta reports the hours in Pacific time (the Graph API's insights day), so they are returned with
   * that zone and converted where they are used.
   */
  async audienceHours(): Promise<{ timeZone: string; hours: number[] } | undefined> {
    const { data } = await this.#get<{ data?: Array<{ name: string; values?: Array<{ value?: Record<string, number> | number }> }> }>(
      `/${this.#user}/insights`,
      { metric: 'online_followers', period: 'lifetime' },
      'read the online followers',
    );
    const values = data?.find((m) => m.name === 'online_followers')?.values ?? [];
    const hours = Array.from({ length: 24 }, () => 0);
    let seen = false;
    for (const { value } of values) {
      if (!value || typeof value !== 'object') continue;
      for (const [hour, count] of Object.entries(value)) {
        const h = Number(hour);
        if (!Number.isInteger(h) || h < 0 || h > 23 || typeof count !== 'number') continue;
        hours[h] = (hours[h] ?? 0) + count;
        seen = true;
      }
    }
    return seen && hours.some((h) => h > 0) ? { timeZone: 'America/Los_Angeles', hours } : undefined;
  }

  /** The token's account, which must be the configured one */
  async check(): Promise<Check> {
    try {
      const me = await this.#get<{ user_id?: string; id: string; username: string; name?: string; profile_picture_url?: string }>(
        '/me',
        { fields: 'user_id,username,name,profile_picture_url' },
        'check',
      );
      // `user_id` is the professional account's id, the one media is published under; `id` is app-scoped
      if (me.user_id !== this.#user && me.id !== this.#user) {
        return { ok: false, problem: `the token belongs to @${me.username}, not to the account ${this.#user}` };
      }
      // The picture is a signed CDN address that expires after a few days: it is read again on every check
      return okCheck(`@${me.username}`, { avatarUrl: me.profile_picture_url, displayName: me.name });
    } catch (error) {
      return checkProblem(error);
    }
  }

  async profileStats(): Promise<ProfileStats> {
    const me = await this.#get<{ followers_count?: number; follows_count?: number; media_count?: number }>(
      '/me',
      { fields: 'followers_count,follows_count,media_count' },
      'read the profile',
    );
    return statsOf({ followers: me.followers_count, following: me.follows_count, posts: me.media_count });
  }

  /** Swaps the long-lived token for a fresh one (valid 60 more days); allowed once it is 24 h old. */
  async refreshToken(): Promise<{ accessToken: string; expiresIn: number }> {
    const query = new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: this.#token });
    const response = await this.#fetch(`https://graph.instagram.com/refresh_access_token?${query}`);
    const refreshed = await json<{ access_token: string; expires_in: number }>('Instagram', response, 'refresh the token');
    return { accessToken: refreshed.access_token, expiresIn: refreshed.expires_in };
  }
}
