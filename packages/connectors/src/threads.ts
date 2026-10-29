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
  type Deletable,
  type Metrics,
  type MetricsMany,
  type Profile,
  type ProfileStats,
  type Published,
  type Replier,
  type ReplyTarget,
  type SentReply,
} from './http.ts';

export interface ThreadsPost {
  /** At most 500 characters; the link to the article goes inside it */
  text: string;
  /** A public JPEG or PNG Threads fetches when the container is created */
  imageUrl?: string;
}

export interface ThreadsOptions {
  userId: string;
  accessToken: string;
  fetch?: typeof fetch;
  /** The Graph API version of Threads */
  version?: string;
  pollMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Where the account's username is kept between runs */
  cache?: IdentityCache;
}

/** Meta moved Threads to threads.com in 2025; its API docs use this host now */
export const THREADS_GRAPH = 'https://graph.threads.com';

/** Threads' user insights read nothing from before this moment (2024-04-13) */
const INSIGHTS_FLOOR_SECONDS = 1_712_991_600;
const DAY_SECONDS = 86_400;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const URL_IN_TEXT = /https?:\/\/[^\s<>"']+/g;
/** An address without its query and fragment, the way two links to one article match */
const bare = (url: string) => {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname.replace(/\/$/, '')}`;
  } catch {
    return url;
  }
};

interface ThreadsReply {
  id: string;
  text?: string;
  username?: string;
  timestamp: string;
  permalink?: string;
  replied_to?: { id: string };
  root_post?: { id: string };
}

/**
 * Threads through the Threads API: a media container (text, or an image with its text), waited on
 * until Threads has processed it, then published; deleted with `threads_delete`; its insights and
 * replies read back. The Threads API has no edit. The long-lived token (60 days) is refreshed by
 * `refreshToken`, as Instagram's is.
 */
export class Threads implements Deletable, CommentReader, Replier {
  readonly #user: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #base: string;
  readonly #pollMs: number;
  readonly #timeoutMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  #username: Promise<string> | undefined;
  readonly #cache: IdentityCache | undefined;

  constructor(options: ThreadsOptions) {
    this.#user = options.userId;
    this.#token = options.accessToken;
    this.#cache = options.cache;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#base = `${THREADS_GRAPH}/${options.version ?? 'v1.0'}`;
    this.#pollMs = options.pollMs ?? 5_000;
    this.#timeoutMs = options.timeoutMs ?? 5 * 60_000;
    this.#sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async #post<T>(path: string, params: Record<string, string>, what: string): Promise<T> {
    const response = await this.#fetch(`${this.#base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...params, access_token: this.#token }),
    });
    return json<T>('Threads', response, what);
  }

  async #get<T>(path: string, params: Record<string, string>, what: string): Promise<T> {
    const query = new URLSearchParams({ ...params, access_token: this.#token });
    return json<T>('Threads', await this.#fetch(`${this.#base}${path}?${query}`), what);
  }

  /** Publishing a container Threads has not processed yet fails; Meta suggests waiting about 30 seconds for an image */
  async #ready(containerId: string): Promise<void> {
    const deadline = Date.now() + this.#timeoutMs;
    for (;;) {
      const { status, error_message: problem } = await this.#get<{ status: string; error_message?: string }>(`/${containerId}`, { fields: 'status,error_message' }, 'check the container');
      if (status === 'FINISHED') return;
      if (status === 'ERROR' || status === 'EXPIRED') throw new ConnectorError('Threads', `the post could not be processed (${status}${problem ? `: ${problem}` : ''}); check that the image URL is public`);
      if (Date.now() > deadline) throw new ConnectorError('Threads', `the post was still ${status} after ${this.#timeoutMs} ms`);
      await this.#sleep(this.#pollMs);
    }
  }

  async #publish(params: Record<string, string>, what: string): Promise<string> {
    const { id: container } = await this.#post<{ id: string }>(`/${this.#user}/threads`, params, what);
    await this.#ready(container);
    // Publishing twice would post twice: a failure from here on is not retried by the engine
    const { id } = await this.#post<{ id: string }>(`/${this.#user}/threads_publish`, { creation_id: container }, 'publish').catch((error: unknown) => {
      throw error instanceof ConnectorError && error.status !== undefined && error.status < 500 ? error : new ConnectorError('Threads', `publish: ${error instanceof Error ? error.message : String(error)}`, undefined, false);
    });
    return id;
  }

  async publish(post: ThreadsPost): Promise<Published> {
    const params: Record<string, string> = post.imageUrl ? { media_type: 'IMAGE', image_url: post.imageUrl, text: post.text } : { media_type: 'TEXT', text: post.text };
    const id = await this.#publish(params, 'create the post');
    const { permalink } = await this.#get<{ permalink?: string }>(`/${id}`, { fields: 'permalink' }, 'read the permalink');
    return { externalId: id, url: permalink ?? 'https://www.threads.com/' };
  }

  /** Needs `threads_delete`; Threads allows 100 deletes a day per account */
  async delete(externalId: string): Promise<void> {
    const response = await this.#fetch(`${this.#base}/${externalId}?${new URLSearchParams({ access_token: this.#token })}`, { method: 'DELETE' });
    await json<{ success?: boolean }>('Threads', response, 'delete');
  }

  /** Views, likes, replies, reposts, quotes and shares; needs `threads_manage_insights` */
  async metrics(externalId: string): Promise<Metrics> {
    const { data } = await this.#get<{ data: Array<{ name: string; values?: Array<{ value: number }>; total_value?: { value: number } }> }>(
      `/${externalId}/insights`,
      { metric: 'views,likes,replies,reposts,quotes,shares' },
      'metrics',
    );
    const out: Metrics = {};
    for (const metric of data) out[metric.name] = metric.total_value?.value ?? metric.values?.[0]?.value ?? 0;
    return out;
  }

  /**
   * Each post's insights, and the clicks on the links in it. Threads counts link clicks for the
   * account, per link address (`clicks`, since 2025-07), not per post: each address clicked since the
   * oldest of these posts went out is given to the newest post that carries it, the same address
   * first, else the same page without its query. A post with a link that nobody clicked has 0. A
   * post whose insights fail is left out, and the clicks failing leaves the posts' own numbers; both
   * are said in `problems`.
   */
  async metricsMany(externalIds: string[]): Promise<MetricsMany> {
    const out: MetricsMany = new Map();
    const problems: string[] = [];
    for (const id of externalIds) {
      try {
        out.set(id, await this.metrics(id));
      } catch (error) {
        problems.push(`${id}: ${message(error)}`);
      }
    }
    try {
      const posts = await this.#ownPosts(new Set(out.keys()));
      const withLinks = posts.filter((p) => p.links.length > 0).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      if (withLinks.length > 0) {
        const oldest = Math.floor(Date.parse(withLinks.at(-1)!.timestamp) / 1000);
        const now = Math.floor(Date.now() / 1000);
        const since = Math.max(INSIGHTS_FLOOR_SECONDS, oldest - DAY_SECONDS);
        const { data } = await this.#get<{ data: Array<{ name: string; link_total_values?: Array<{ value: number; link_url: string }> }> }>(
          `/${this.#user}/threads_insights`,
          { metric: 'clicks', since: String(since), until: String(now) },
          'read the link clicks',
        );
        for (const post of withLinks) out.get(post.id)!.clicks = 0;
        for (const link of data.find((m) => m.name === 'clicks')?.link_total_values ?? []) {
          const post = withLinks.find((p) => p.links.includes(link.link_url)) ?? withLinks.find((p) => p.links.some((l) => bare(l) === bare(link.link_url)));
          if (post) out.get(post.id)!.clicks! += link.value;
        }
      }
    } catch (error) {
      problems.push(`link clicks: ${message(error)}`);
    }
    if (problems.length > 0) out.problems = problems;
    return out;
  }

  /** Of the account's own posts, the ones asked for, with when they went out and the links in them (five pages of 100 at most) */
  async #ownPosts(ids: ReadonlySet<string>): Promise<Array<{ id: string; timestamp: string; links: string[] }>> {
    const found: Array<{ id: string; timestamp: string; links: string[] }> = [];
    let after: string | undefined;
    for (let page = 0; page < 5 && found.length < ids.size; page++) {
      const answer = await this.#get<{ data: Array<{ id: string; text?: string; timestamp: string; link_attachment_url?: string }>; paging?: { cursors?: { after?: string }; next?: string } }>(
        `/${this.#user}/threads`,
        { fields: 'id,text,timestamp,link_attachment_url', limit: '100', ...(after && { after }) },
        'read the posts',
      );
      for (const post of answer.data) {
        if (!ids.has(post.id)) continue;
        const links = [...new Set([...(post.text?.match(URL_IN_TEXT) ?? []), ...(post.link_attachment_url ? [post.link_attachment_url] : [])])];
        found.push({ id: post.id, timestamp: post.timestamp, links });
      }
      after = answer.paging?.next ? answer.paging.cursors?.after : undefined;
      if (!after) break;
    }
    return found;
  }

  async #ownName(): Promise<string> {
    const load = () => this.#get<{ username: string }>('/me', { fields: 'username' }, 'read the account').then((me) => me.username);
    // Kept a day between runs, so /me is not asked hourly
    this.#username ??= (this.#cache ? this.#cache.remember(`threads-me:${secretTag(this.#token)}`, 86_400, load) : load()).then(
      (name) => name,
      (error: unknown) => {
        this.#username = undefined;
        throw error;
      },
    );
    return this.#username;
  }

  /**
   * Every reply under the post, at any depth (the conversation edge, oldest first, ten pages of 100
   * at most). Needs `threads_read_replies`.
   */
  async comments(externalId: string): Promise<Comment[]> {
    const own = await this.#ownName();
    const out: Comment[] = [];
    let after: string | undefined;
    for (let page = 0; page < 10; page++) {
      const answer = await this.#get<{ data: ThreadsReply[]; paging?: { cursors?: { after?: string }; next?: string } }>(
        `/${externalId}/conversation`,
        { fields: 'id,text,username,timestamp,permalink,replied_to,root_post', reverse: 'false', limit: '100', ...(after && { after }) },
        'read the replies',
      );
      for (const r of answer.data) {
        const parent = r.replied_to?.id;
        out.push({
          externalId: r.id,
          author: { handle: `@${r.username ?? 'unknown'}` },
          text: r.text ?? '',
          createdAt: r.timestamp,
          ...(r.permalink && { url: r.permalink }),
          // A reply to the post itself has the post as its parent: it is a comment on the post
          ...(parent && parent !== externalId && { inReplyTo: parent }),
          own: r.username === own,
        });
      }
      after = answer.paging?.next ? answer.paging.cursors?.after : undefined;
      if (!after) break;
    }
    return out;
  }

  /** A reply is a post of its own with `reply_to_id`; needs `threads_manage_replies` */
  async reply(target: ReplyTarget, text: string): Promise<SentReply> {
    const id = await this.#publish({ media_type: 'TEXT', text, reply_to_id: target.commentExternalId }, 'create the reply');
    const { permalink } = await this.#get<{ permalink?: string }>(`/${id}`, { fields: 'permalink' }, 'read the permalink').catch(() => ({ permalink: undefined }));
    return { externalId: id, ...(permalink && { url: permalink }) };
  }

  /** The token's account, which must be the configured one */
  async check(): Promise<Check> {
    try {
      const me = await this.#get<{ id: string; username: string; name?: string; threads_profile_picture_url?: string }>('/me', { fields: 'id,username,name,threads_profile_picture_url' }, 'check');
      if (me.id !== this.#user) return { ok: false, problem: `the token belongs to @${me.username}, not to the account ${this.#user}` };
      return okCheck(`@${me.username}`, { avatarUrl: me.threads_profile_picture_url, displayName: me.name });
    } catch (error) {
      return checkProblem(error);
    }
  }

  /**
   * Followers, and how often the profile was viewed the day before (UTC). The Threads API counts
   * neither the accounts followed nor the posts. The views failing is said, never fails the count.
   */
  async profileStats(): Promise<ProfileStats> {
    const { data } = await this.#get<{ data: Array<{ name: string; total_value?: { value: number } }> }>(`/${this.#user}/threads_insights`, { metric: 'followers_count' }, 'read the profile');
    const followers = data.find((m) => m.name === 'followers_count')?.total_value?.value;
    const today = Math.floor(Date.now() / 1000 / DAY_SECONDS) * DAY_SECONDS;
    try {
      const views = await this.#get<{ data: Array<{ name: string; values?: Array<{ value: number }> }> }>(
        `/${this.#user}/threads_insights`,
        { metric: 'views', since: String(today - DAY_SECONDS), until: String(today) },
        'read the profile views',
      );
      const values = views.data.find((m) => m.name === 'views')?.values ?? [];
      return statsOf({ followers }, { profileViews1d: values.reduce((n, v) => n + v.value, 0) });
    } catch (error) {
      return { ...statsOf({ followers }), unread: [`profile views: ${message(error)}`] };
    }
  }

  /** The name, the bio and the picture (`threads_basic`); the API gives no links and changes nothing */
  async profile(): Promise<Profile> {
    const me = await this.#get<{ name?: string; threads_biography?: string; threads_profile_picture_url?: string }>('/me', { fields: 'name,threads_biography,threads_profile_picture_url' }, 'read the profile');
    return {
      ...(me.name?.trim() && { displayName: me.name }),
      ...(me.threads_biography?.trim() && { bio: me.threads_biography }),
      links: [],
      hasAvatar: imageUrl(me.threads_profile_picture_url) !== undefined,
    };
  }

  /** Swaps the long-lived token for a fresh one (60 more days); allowed once it is 24 h old */
  async refreshToken(): Promise<{ accessToken: string; expiresIn: number }> {
    const query = new URLSearchParams({ grant_type: 'th_refresh_token', access_token: this.#token });
    const refreshed = await json<{ access_token: string; expires_in: number }>('Threads', await this.#fetch(`${THREADS_GRAPH}/refresh_access_token?${query}`), 'refresh the token');
    return { accessToken: refreshed.access_token, expiresIn: refreshed.expires_in };
  }
}
