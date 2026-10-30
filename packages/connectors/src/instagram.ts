import {
  checkProblem,
  imageUrl,
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
  type Profile,
  type ProfileStats,
  type Published,
  type Replier,
  type ReplyTarget,
  type SentReply,
} from './http.ts';

/** One insight as the Graph API answers it: a lifetime total, or a value per breakdown */
interface Insight {
  name: string;
  values?: Array<{ value: number }>;
  total_value?: { value: number; breakdowns?: Array<{ results?: Array<{ dimension_values?: string[]; value: number }> }> };
}

const valueOf = (m: Insight) => m.total_value?.value ?? m.values?.[0]?.value ?? 0;

/*
 * Each piece's insights by type (Meta's media insights reference): a metric a type does not have
 * fails the whole call, so each type asks for its own set, and what may be missing (a breakdown, a
 * Reel's Facebook views) is asked for in a call of its own whose refusal costs nothing else.
 * `reposts` is left out of a feed post's set: Meta's reference still lists it for FEED, but since
 * 2026-10-29 the Instagram Login API refuses it there ("does not support the metrics: reposts"). A
 * piece whose type cannot be read is asked without it too, since it is most likely a feed post.
 */
const BOTH = 'views,reach,likes,comments,saved,shares,total_interactions';
const FEED_METRICS = `${BOTH},follows,profile_visits`;
const REELS_METRICS = `${BOTH},reposts,ig_reels_avg_watch_time,reels_skip_rate`;
const STORY_METRICS = 'views,reach,shares,reposts,total_interactions,follows,profile_visits';
/** Meta's names that read badly as words on a page; the average watch time is in milliseconds */
const RENAMED: Readonly<Record<string, string>> = { ig_reels_avg_watch_time: 'avg_watch_ms', reels_skip_rate: 'skip_rate' };
/** A story's navigation, by Meta's action */
const NAVIGATION: Readonly<Record<string, string>> = { TAP_FORWARD: 'taps_forward', TAP_BACK: 'taps_back', TAP_EXIT: 'exits', SWIPE_FORWARD: 'swipes_forward' };
/** The account's insights over the last 24 hours, as the daily snapshot keeps them */
const ACCOUNT_METRICS: Readonly<Record<string, string>> = {
  views: 'views1d',
  reach: 'reach1d',
  accounts_engaged: 'accountsEngaged1d',
  total_interactions: 'interactions1d',
  profile_links_taps: 'linkTaps1d',
};
/** How long a piece's once-a-day numbers are kept before they are asked for again */
const DAY_SECONDS = 86_400;
/** Meta gives follows and unfollows only from 100 followers up */
const FOLLOWS_MIN_FOLLOWERS = 100;

/**
 * Graph API's (#10) on a story's insights when fewer than five accounts saw it and Meta keeps its
 * numbers back. Matched by its message only: code 10 is also Graph API's "permission denied", and a
 * token without `instagram_business_manage_insights` must fail, not read as a story nobody saw.
 */
const NOT_ENOUGH_VIEWERS = /not enough viewers/i;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Graph API's (#100) when a set names a metric the piece's type no longer has: the names follow */
const UNSUPPORTED = /does not support the metrics?:?\s*([a-z_]+(?:\s*,\s*[a-z_]+)*)/i;

/**
 * The metrics Meta refused by name, by account and set, for as long as the process runs: a set is
 * asked without them from then on, so one retired metric costs one extra call, not every reading.
 */
const REFUSED = new Map<string, Set<string>>();

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

  async #insights(id: string, params: Record<string, string>, what: string): Promise<Insight[]> {
    return (await this.#get<{ data?: Insight[] }>(`/${id}/insights`, params, what)).data ?? [];
  }

  /** One metric's total, and its values by its breakdown's dimension (`BIO_LINK_CLICKED`, `TAP_FORWARD`…) */
  async #breakdown(id: string, params: Record<string, string>, what: string): Promise<{ total: number; by: Record<string, number> }> {
    const [metric] = await this.#insights(id, params, what);
    const by: Record<string, number> = {};
    for (const r of metric?.total_value?.breakdowns?.[0]?.results ?? []) {
      // Meta documents these values in capitals but has answered some in lower case: one case for every lookup
      const key = r.dimension_values?.[0]?.toUpperCase();
      if (key) by[key] = (by[key] ?? 0) + r.value;
    }
    return { total: metric ? valueOf(metric) : 0, by };
  }

  /**
   * A piece's main set of insights. When Meta refuses metrics by name, the set is asked again once
   * without them, and they are remembered (`REFUSED`), so the rest of the piece's numbers still count.
   */
  async #counters(id: string, metrics: string, what: string): Promise<Insight[]> {
    const key = `${this.#user}:${metrics}`;
    const refused = REFUSED.get(key) ?? new Set<string>();
    const ask = () => metrics.split(',').filter((m) => !refused.has(m));
    try {
      return await this.#insights(id, { metric: ask().join(',') }, what);
    } catch (error) {
      const named = UNSUPPORTED.exec(message(error))?.[1]?.split(/\s*,\s*/).filter((m) => ask().includes(m)) ?? [];
      if (!named.length || named.length === ask().length) throw error;
      for (const m of named) refused.add(m);
      REFUSED.set(key, refused);
      return this.#insights(id, { metric: ask().join(',') }, what);
    }
  }

  #numbers(data: Insight[]): Metrics {
    const out: Metrics = {};
    for (const metric of data) out[RENAMED[metric.name] ?? metric.name] = valueOf(metric);
    return out;
  }

  /**
   * A published piece's type (IMAGE, VIDEO, CAROUSEL_ALBUM), which never changes: kept a month where
   * there is a cache. A single video is a Reel, as `publish` makes it. Undefined when it cannot be read.
   */
  async #mediaType(id: string): Promise<string | undefined> {
    const load = () => this.#get<{ media_type?: string }>(`/${id}`, { fields: 'media_type' }, 'read the media type').then((m) => m.media_type ?? '');
    try {
      return (await (this.#cache ? this.#cache.remember(`instagram-media-type:${id}`, 30 * 86_400, load) : load())) || undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * A post's insights, by its type. Every post: views (every time on screen; `views` replaced
   * impressions and plays in 2025), reach (unique accounts), likes, comments, saves, shares and total
   * interactions. A feed post or carousel also: follows, profile visits, and the profile actions it
   * brought (`profile_activity`, with its bio-link clicks, in a call of its own). A Reel: its reposts,
   * its average watch time (`avg_watch_ms`) and skip rate (`skip_rate`, a percentage), and the views
   * it got on Facebook when it was shared there (`facebook_views`, which Meta refuses for a Reel that
   * was not). The profile activity and the Facebook views are read once a day (`#daily`), the rest on
   * every call. A post whose type cannot be read gets what every type has.
   */
  async metrics(externalId: string): Promise<Metrics> {
    const type = await this.#mediaType(externalId);
    const reel = type === 'VIDEO';
    const feed = type === 'IMAGE' || type === 'CAROUSEL_ALBUM';
    const out = this.#numbers(await this.#counters(externalId, reel ? REELS_METRICS : feed ? FEED_METRICS : BOTH, 'metrics'));
    if (feed) {
      Object.assign(
        out,
        await this.#daily(`instagram-profile-activity:${externalId}`, async () => {
          const activity = await this.#breakdown(externalId, { metric: 'profile_activity', breakdown: 'action_type' }, 'read the profile activity');
          return { profile_activity: activity.total, bio_link_clicks: activity.by.BIO_LINK_CLICKED ?? 0 };
        }),
      );
    }
    if (reel) {
      Object.assign(out, await this.#daily(`instagram-facebook-views:${externalId}`, async () => this.#numbers(await this.#insights(externalId, { metric: 'facebook_views' }, 'read the Facebook views'))));
    }
    return out;
  }

  /**
   * A piece's secondary numbers, read at most once a day where there is a cache: each is a call of its
   * own, and asking for them hourly doubled the calls an hour against Meta's per-account limit. A
   * refusal (a Reel not shared to Facebook) is kept the same day as no numbers, so it is not asked for
   * again every hour either.
   */
  async #daily(key: string, load: () => Promise<Metrics>): Promise<Metrics> {
    const read = () => load().then((m) => JSON.stringify(m), () => '{}');
    try {
      return JSON.parse(await (this.#cache ? this.#cache.remember(key, DAY_SECONDS, read) : read())) as Metrics;
    } catch {
      return {};
    }
  }

  /**
   * A story's insights, which Meta keeps for its 24 hours only: views, reach, shares, reposts, total
   * interactions, follows and profile visits, and how people moved through it (taps forward and back,
   * exits, swipes on to the next account's), asked apart since `navigation` takes a breakdown no
   * other metric has. A story fewer than five accounts saw has no numbers yet: Meta answers #10,
   * which is not a failure.
   */
  async storyMetrics(externalId: string): Promise<Metrics> {
    let out: Metrics;
    try {
      out = this.#numbers(await this.#counters(externalId, STORY_METRICS, 'story metrics'));
    } catch (error) {
      if (NOT_ENOUGH_VIEWERS.test(message(error))) return {};
      throw error;
    }
    await this.#breakdown(externalId, { metric: 'navigation', breakdown: 'story_navigation_action_type' }, 'read the story navigation').then(
      (navigation) => {
        for (const [action, name] of Object.entries(NAVIGATION)) out[name] = navigation.by[action] ?? 0;
      },
      () => undefined,
    );
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

  /**
   * The counts, and the account's insights over the last 24 hours (Meta's default for them): views,
   * reach, accounts engaged, interactions, taps on the profile's links, and from 100 followers up the
   * follows and unfollows. An insight Meta refuses is said, and never fails the counts.
   */
  async profileStats(): Promise<ProfileStats> {
    const me = await this.#get<{ followers_count?: number; follows_count?: number; media_count?: number }>(
      '/me',
      { fields: 'followers_count,follows_count,media_count' },
      'read the profile',
    );
    const extra: Record<string, number> = {};
    const unread: string[] = [];
    try {
      const data = await this.#insights(this.#user, { metric: Object.keys(ACCOUNT_METRICS).join(','), period: 'day', metric_type: 'total_value' }, 'read the account insights');
      for (const metric of data) {
        const name = ACCOUNT_METRICS[metric.name];
        if (name) extra[name] = valueOf(metric);
      }
    } catch (error) {
      unread.push(`account insights: ${message(error)}`);
    }
    if ((me.followers_count ?? 0) >= FOLLOWS_MIN_FOLLOWERS) {
      try {
        const follows = await this.#breakdown(this.#user, { metric: 'follows_and_unfollows', period: 'day', metric_type: 'total_value', breakdown: 'follow_type' }, 'read the follows');
        extra.follows1d = follows.by.FOLLOWER ?? 0;
        extra.unfollows1d = follows.by.NON_FOLLOWER ?? 0;
      } catch (error) {
        unread.push(`follows and unfollows: ${message(error)}`);
      }
    }
    return { ...statsOf({ followers: me.followers_count, following: me.follows_count, posts: me.media_count }, extra), ...(unread.length > 0 && { unread }) };
  }

  /**
   * The profile as Instagram shows it: the name, the bio, the picture, and the website, which is the
   * one link the API gives of up to five. Instagram's API changes none of them.
   */
  async profile(): Promise<Profile> {
    const me = await this.#get<{ name?: string; biography?: string; website?: string; profile_picture_url?: string }>('/me', { fields: 'name,biography,website,profile_picture_url' }, 'read the profile');
    return {
      ...(me.name?.trim() && { displayName: me.name }),
      ...(me.biography?.trim() && { bio: me.biography }),
      links: me.website?.trim() ? [{ name: 'Website', value: me.website.trim() }] : [],
      hasAvatar: imageUrl(me.profile_picture_url) !== undefined,
    };
  }

  /** Swaps the long-lived token for a fresh one (valid 60 more days); allowed once it is 24 h old. */
  async refreshToken(): Promise<{ accessToken: string; expiresIn: number }> {
    const query = new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: this.#token });
    const response = await this.#fetch(`https://graph.instagram.com/refresh_access_token?${query}`);
    const refreshed = await json<{ access_token: string; expires_in: number }>('Instagram', response, 'refresh the token');
    return { accessToken: refreshed.access_token, expiresIn: refreshed.expires_in };
  }
}
