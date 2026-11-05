import {
  checkProblem,
  imageUrl,
  type IdentityCache,
  ConnectorError,
  json,
  okCheck,
  statsOf,
  type Check,
  type Comment,
  type CommentReader,
  type Deletable,
  type Editable,
  type Metrics,
  type Profile,
  type ProfileStats,
  type Published,
  type Replier,
  type ReplyTarget,
  type SentReply,
} from './http.ts';
import { graphId, META_GRAPH_VERSION, readInsights, refusedInsights } from './meta/graph.ts';

const NETWORK = 'Facebook';

/*
 * A Page post's insights: unique accounts reached (`views`), clicks on it, and its reactions by type,
 * summed. Comments and shares come from the post itself, which counts them without insights.
 */
export const FACEBOOK_POST_METRICS = ['post_impressions_unique', 'post_clicks', 'post_reactions_by_type_total'] as const;
/** The Page's own insights, read for the last day in the daily snapshot */
export const FACEBOOK_PAGE_METRICS = ['page_follows', 'page_post_engagements'] as const;

/** Each insight's family in the channel's definition */
const POST_FAMILY: Readonly<Record<string, string>> = { post_impressions_unique: 'views', post_clicks: 'clicks', post_reactions_by_type_total: 'reactions' };
const PAGE_EXTRA: Readonly<Record<string, string>> = { page_follows: 'follows1d', page_post_engagements: 'engagements1d' };

/** An insight as the Graph API answers it: one value per period, a number or counts by type */
interface Insight {
  name: string;
  values?: Array<{ value?: number | Record<string, number> }>;
}

/** The latest period's value; counts by type (reactions) are summed */
function latest(insight: Insight): number | undefined {
  const value = insight.values?.at(-1)?.value;
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object') return Object.values(value).reduce((n, v) => n + (typeof v === 'number' ? v : 0), 0);
  return undefined;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Where a page of comments continues: only Meta's own host, since the address carries the token */
const NEXT_PAGE = 'https://graph.facebook.com/';

export interface FacebookPageOptions {
  pageId: string;
  /** A Page access token, which acts as the Page */
  accessToken: string;
  fetch?: typeof fetch;
  /** The Graph API version; Meta retires versions about two years after release */
  version?: string;
  /** Taken as every connector's is; the Page's id is configured, so there is no identity to keep */
  cache?: IdentityCache;
}

type FbComment = { id: unknown; message?: string; created_time: string; from?: { id?: string; name?: string }; parent?: { id?: unknown } };

/**
 * A Facebook Page through the Graph API with a Page access token: a link post on its feed (the card
 * is the article's own, from its link), edited in place and deleted; its insights; its comments read
 * and answered; the Page's numbers and profile, read only.
 */
export class FacebookPage implements CommentReader, Replier, Editable<{ text: string }>, Deletable {
  readonly #page: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #base: string;

  constructor(options: FacebookPageOptions) {
    this.#page = options.pageId;
    this.#token = options.accessToken;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#base = `https://graph.facebook.com/${options.version ?? META_GRAPH_VERSION}`;
  }

  async #post<T>(path: string, params: Record<string, string>, what: string): Promise<T> {
    const response = await this.#fetch(`${this.#base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...params, access_token: this.#token }),
    });
    return json<T>(NETWORK, response, what);
  }

  async #get<T>(path: string, params: Record<string, string>, what: string): Promise<T> {
    const query = new URLSearchParams({ ...params, access_token: this.#token });
    return json<T>(NETWORK, await this.#fetch(`${this.#base}${path}?${query}`), what);
  }

  /** A link post: the image is not sent, Facebook builds the card from the article's own tags */
  async publish(post: { text: string; link: string; imageUrl: string }): Promise<Published> {
    // Posting twice would post twice: a failure without Meta's own refusal is not retried by the engine
    const created = await this.#post<{ id?: unknown }>(`/${this.#page}/feed`, { message: post.text, link: post.link }, 'publish').catch((error: unknown) => {
      throw error instanceof ConnectorError && error.status !== undefined && error.status < 500 ? error : new ConnectorError(NETWORK, `publish: ${message(error)}`, undefined, false);
    });
    const id = graphId(created.id, 'publish', NETWORK);
    // The post is out: a permalink that cannot be read must not make the engine publish again
    const permalink = await this.#get<{ permalink_url?: string }>(`/${id}`, { fields: 'permalink_url' }, 'read the permalink').then(
      (p) => p.permalink_url,
      () => undefined,
    );
    return { externalId: id, url: permalink ?? `https://www.facebook.com/${id}` };
  }

  async edit(externalId: string, piece: { text: string }): Promise<void> {
    await this.#post<{ success?: boolean }>(`/${externalId}`, { message: piece.text }, 'edit');
  }

  async delete(externalId: string): Promise<void> {
    const response = await this.#fetch(`${this.#base}/${externalId}?${new URLSearchParams({ access_token: this.#token })}`, { method: 'DELETE' });
    await json<{ success?: boolean }>(NETWORK, response, 'delete');
  }

  /**
   * A set of insights without what Meta refuses. The Page insights API refuses an unknown metric
   * with a (#100) that does not name it, so such a refusal is narrowed down metric by metric.
   */
  async #insights(id: string, set: string, metrics: readonly string[], params: Record<string, string>, what: string): Promise<Insight[]> {
    return readInsights(
      `facebook:${this.#page}:${set}`,
      metrics,
      async (asked) => (await this.#get<{ data?: Insight[] }>(`/${id}/insights`, { ...params, metric: asked.join(',') }, what)).data ?? [],
      { probeUnnamed: true },
    );
  }

  /**
   * Reach (`views`), clicks and reactions from the post's insights; comments and shares from the post
   * itself, whose reaction count stands in when Meta refuses the reactions insight.
   */
  async metrics(externalId: string): Promise<Metrics> {
    const out: Metrics = {};
    for (const insight of await this.#insights(externalId, 'post', FACEBOOK_POST_METRICS, {}, 'metrics')) {
      const family = POST_FAMILY[insight.name];
      const value = latest(insight);
      if (family && value !== undefined) out[family] = value;
    }
    const post = await this.#get<{ comments?: { summary?: { total_count?: number } }; shares?: { count?: number }; reactions?: { summary?: { total_count?: number } } }>(
      `/${externalId}`,
      { fields: 'comments.summary(true).limit(0),shares,reactions.summary(true).limit(0)' },
      'read the post counts',
    );
    const reactions = post.reactions?.summary?.total_count;
    if (out.reactions === undefined && reactions !== undefined) out.reactions = reactions;
    out.comments = post.comments?.summary?.total_count ?? 0;
    // A post nobody shared has no `shares` at all
    out.shares = post.shares?.count ?? 0;
    return out;
  }

  /**
   * Every comment under the post, replies included, oldest first (`stream`), ten pages of 100 at
   * most. A comment from the Page itself is the owner's own.
   */
  async comments(postExternalId: string): Promise<Comment[]> {
    type Page = { data: FbComment[]; paging?: { next?: string } };
    const out: Comment[] = [];
    let answer = await this.#get<Page>(`/${postExternalId}/comments`, { fields: 'id,message,created_time,from,parent{id}', filter: 'stream', limit: '100' }, 'read the comments');
    for (let page = 0; ; page++) {
      for (const c of answer.data) {
        const name = c.from?.name?.trim();
        // The stream is flat: `parent`, set only on a reply, is what marks a comment answered and threads it
        const parent = typeof c.parent?.id === 'string' && c.parent.id ? c.parent.id : undefined;
        out.push({
          externalId: graphId(c.id, 'read the comments', NETWORK),
          author: { handle: name || 'unknown', ...(name && { displayName: name }) },
          text: c.message ?? '',
          createdAt: c.created_time,
          ...(parent && { inReplyTo: parent }),
          own: c.from?.id === this.#page,
        });
      }
      const next = answer.paging?.next;
      if (!next?.startsWith(NEXT_PAGE) || page >= 9) break;
      answer = await json<Page>(NETWORK, await this.#fetch(next), 'read the comments');
    }
    return out;
  }

  /** A reply is a comment under the comment; Facebook threads it and notifies its author */
  async reply(target: ReplyTarget, text: string): Promise<SentReply> {
    const { id } = await this.#post<{ id?: unknown }>(`/${target.commentExternalId}/comments`, { message: text }, 'reply');
    return { externalId: graphId(id, 'reply', NETWORK) };
  }

  /** The token's Page, which must be the configured one */
  async check(): Promise<Check> {
    try {
      const me = await this.#get<{ id?: unknown; name?: string; picture?: { data?: { url?: string } } }>(`/${this.#page}`, { fields: 'id,name,picture{url}' }, 'check');
      const name = me.name ?? (typeof me.id === 'string' ? me.id : 'another Page');
      if (me.id !== this.#page) return { ok: false, problem: `the token belongs to the Page ${name}, not to the Page ${this.#page}` };
      return okCheck(name, { avatarUrl: me.picture?.data?.url, displayName: me.name });
    } catch (error) {
      return checkProblem(error);
    }
  }

  /**
   * Followers, the Page's likes, and its follows and post engagements over the last day. An insight
   * Meta refuses is said, and never fails the counts.
   */
  async profileStats(): Promise<ProfileStats> {
    const me = await this.#get<{ followers_count?: number; fan_count?: number }>(`/${this.#page}`, { fields: 'followers_count,fan_count' }, 'read the Page');
    const extra: Record<string, number> = { ...(me.fan_count !== undefined && { likes: me.fan_count }) };
    const unread: string[] = [];
    try {
      for (const insight of await this.#insights(this.#page, 'page', FACEBOOK_PAGE_METRICS, { period: 'day' }, 'read the Page insights')) {
        const name = PAGE_EXTRA[insight.name];
        const value = latest(insight);
        if (name && value !== undefined) extra[name] = value;
      }
      const refused = refusedInsights(`facebook:${this.#page}:page`);
      if (refused.length > 0) unread.push(`Page insights: Meta refuses ${refused.join(', ')}`);
    } catch (error) {
      unread.push(`Page insights: ${message(error)}`);
    }
    return { ...statsOf({ followers: me.followers_count }, extra), ...(unread.length > 0 && { unread }) };
  }

  /** The Page's About text and picture; Shipcast changes neither */
  async profile(): Promise<Profile> {
    const me = await this.#get<{ about?: string; picture?: { data?: { url?: string } } }>(`/${this.#page}`, { fields: 'about,picture{url}' }, 'read the profile');
    return {
      ...(me.about?.trim() && { bio: me.about }),
      links: [],
      hasAvatar: imageUrl(me.picture?.data?.url) !== undefined,
    };
  }
}
