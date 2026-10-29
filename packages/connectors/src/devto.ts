import { sourceOfReferrer } from '@shipcast/schema';
import { ConnectorError, checkProblem, expectOk, type AnalyticsMany, secretTag, type IdentityCache, htmlToText, imageUrl, json, okCheck, statsOf, type Check, type Comment, type CommentReader, type Deletable, type Editable, type Metrics, type Profile, type ProfileReader, type ProfileStats, type Published } from './http.ts';

/** What an edit may change; whatever is left out stays as it is */
export type DevtoEdit = Partial<DevtoArticle>;

/** Forem's `/api/analytics/totals` for one article, as `AnalyticsService#totals` builds it */
interface ForemTotals {
  reactions?: { total?: number; like?: number; readinglist?: number; unique_reactors?: number };
  page_views?: { total?: number; average_read_time_in_seconds?: number; total_read_time_in_seconds?: number };
}

/**
 * Forem allows a request with an API key 40 a minute (its Rack::Attack `api_key_throttle`, besides
 * 3 GETs a second per IP): the analytics calls are spaced a little over 1.5 s, to stay under it
 */
const ANALYTICS_PACE_MS = 1_600;
/** The longest Retry-After waited out within a read; a longer one ends the read, the rest left for later */
const MAX_RETRY_AFTER_MS = 60_000;

export interface DevtoArticle {
  title: string;
  /** The article's Markdown, with every link and image absolute: dev.to does not resolve relative ones */
  markdown: string;
  tags: string[];
  /** The blog's URL of the same article: dev.to marks it canonical so the copies do not compete */
  canonicalUrl: string;
  /** Cover image, an absolute URL */
  mainImage?: string;
}

/**
 * dev.to through its API (Forem v1): an article republished from the blog with `canonical_url` set,
 * and its views, reactions and comments read back from the author's own list. An article can be
 * edited; Forem's API has no delete, so `delete` unpublishes it (it stays in the author's drafts).
 */
export class Devto implements Editable<DevtoEdit>, Deletable, CommentReader, ProfileReader {
  readonly #key: string;
  readonly #fetch: typeof fetch;
  readonly #base: string;
  #username: Promise<string> | undefined;
  readonly #cache: IdentityCache | undefined;

  readonly #paceMs: number;
  readonly #sleep: (ms: number) => Promise<void>;

  /** `paceMs` spaces the analytics calls (Forem allows an API key 40 a minute); a test gives 0, or its own `sleep` */
  constructor(options: { apiKey: string; fetch?: typeof fetch; baseUrl?: string; cache?: IdentityCache; paceMs?: number; sleep?: (ms: number) => Promise<void> }) {
    this.#cache = options.cache;
    this.#paceMs = options.paceMs ?? ANALYTICS_PACE_MS;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#key = options.apiKey;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#base = options.baseUrl ?? 'https://dev.to/api';
  }

  #headers(): Record<string, string> {
    return { 'api-key': this.#key, accept: 'application/vnd.forem.api-v1+json', 'content-type': 'application/json' };
  }

  async publish(article: DevtoArticle): Promise<Published> {
    const response = await this.#fetch(`${this.#base}/articles`, {
      method: 'POST',
      headers: this.#headers(),
      body: JSON.stringify({
        article: {
          title: article.title,
          body_markdown: article.markdown,
          published: true,
          tags: article.tags,
          canonical_url: article.canonicalUrl,
          ...(article.mainImage ? { main_image: article.mainImage } : {}),
        },
      }),
    });
    const created = await json<{ id: number; url: string }>('dev.to', response, 'publish');
    return { externalId: String(created.id), url: created.url };
  }

  async #update(externalId: string, article: Record<string, unknown>, what: string): Promise<void> {
    const response = await this.#fetch(`${this.#base}/articles/${encodeURIComponent(externalId)}`, {
      method: 'PUT',
      headers: this.#headers(),
      body: JSON.stringify({ article }),
    });
    await expectOk('dev.to', response, what);
  }

  async edit(externalId: string, edit: DevtoEdit): Promise<void> {
    await this.#update(
      externalId,
      {
        ...(edit.title !== undefined && { title: edit.title }),
        ...(edit.markdown !== undefined && { body_markdown: edit.markdown }),
        ...(edit.tags !== undefined && { tags: edit.tags }),
        ...(edit.canonicalUrl !== undefined && { canonical_url: edit.canonicalUrl }),
        ...(edit.mainImage !== undefined && { main_image: edit.mainImage }),
      },
      'edit',
    );
  }

  /** dev.to cannot delete through its API: the article goes back to the author's drafts, off the site */
  async delete(externalId: string): Promise<void> {
    await this.#update(externalId, { published: false }, 'unpublish');
  }

  /** The key owner's username, read once: what tells the owner's replies from the others' */
  async #ownName(): Promise<string> {
    const load = () =>
      this.#fetch(`${this.#base}/users/me`, { headers: this.#headers() })
        .then((response) => json<{ username: string }>('dev.to', response, 'read the account'))
        .then((me) => me.username);
    // A username rarely changes: kept a day between runs, so /users/me is not asked hourly
    this.#username ??= (this.#cache ? this.#cache.remember(`devto-me:${secretTag(this.#key)}`, 86_400, load) : load()).then(
        (name) => name,
        (error: unknown) => {
          this.#username = undefined;
          throw error;
        },
      );
    return this.#username;
  }

  /**
   * The comments under an article, threads flattened. Read-only: Forem's API has no endpoint to
   * write a comment, so a reply is written on dev.to itself.
   */
  async comments(externalId: string): Promise<Comment[]> {
    type ForemComment = {
      id_code: string;
      created_at: string;
      body_html?: string;
      deleted?: boolean;
      user?: { username: string; name?: string; profile_image?: string; profile_image_90?: string };
      children?: ForemComment[];
    };
    const list = await json<ForemComment[]>('dev.to', await this.#fetch(`${this.#base}/comments?a_id=${encodeURIComponent(externalId)}`, { headers: this.#headers() }), 'read the comments');
    const own = await this.#ownName();
    const site = new URL(this.#base).origin;
    const out: Comment[] = [];
    const visit = (items: ForemComment[], parent?: string) => {
      for (const c of items) {
        // A deleted comment keeps its place in the thread with no author or text; its replies still count
        if (!c.deleted && c.user) {
          const avatarUrl = imageUrl(c.user.profile_image_90 ?? c.user.profile_image);
          const displayName = c.user.name?.trim();
          out.push({
            externalId: c.id_code,
            author: { handle: `@${c.user.username}`, ...(displayName && { displayName }), ...(avatarUrl && { avatarUrl }) },
            text: htmlToText(c.body_html ?? ''),
            createdAt: c.created_at,
            ...(parent && { inReplyTo: parent }),
            url: `${site}/${c.user.username}/comment/${c.id_code}`,
            own: c.user.username === own,
          });
        }
        visit(c.children ?? [], c.id_code);
      }
    };
    visit(list);
    return out;
  }

  /** The key's owner, proving the key works */
  async check(): Promise<Check> {
    try {
      const me = await json<{ username: string; name?: string; profile_image?: string }>(
        'dev.to',
        await this.#fetch(`${this.#base}/users/me`, { headers: this.#headers() }),
        'check',
      );
      return okCheck(`@${me.username}`, { avatarUrl: me.profile_image, displayName: me.name });
    } catch (error) {
      return checkProblem(error);
    }
  }

  /**
   * Forem gives no counts on the profile, only lists: they are counted a thousand at a time, which is
   * one request for any account short of a thousand followers or articles.
   */
  async #count(path: string, what: string): Promise<number> {
    let total = 0;
    for (let page = 1; page <= 20; page++) {
      const response = await this.#fetch(`${this.#base}${path}?per_page=1000&page=${page}`, { headers: this.#headers() });
      const items = await json<unknown[]>('dev.to', response, what);
      total += items.length;
      if (items.length < 1000) break;
    }
    return total;
  }

  /** The profile as /users/me has it; Forem's API cannot change it, so a review's proposals are to copy */
  async profile(): Promise<Profile> {
    const me = await json<{ name?: string; summary?: string | null; website_url?: string | null; location?: string | null; profile_image?: string }>(
      'dev.to',
      await this.#fetch(`${this.#base}/users/me`, { headers: this.#headers() }),
      'read the profile',
    );
    return {
      ...(me.name?.trim() && { displayName: me.name }),
      ...(me.summary?.trim() && { bio: me.summary }),
      links: [
        ...(me.website_url ? [{ name: 'Website', value: me.website_url }] : []),
        ...(me.location ? [{ name: 'Location', value: me.location }] : []),
      ],
      hasAvatar: imageUrl(me.profile_image) !== undefined,
    };
  }

  /** The followers as /users/me counts them (Forem's `followers_count`), and the articles by paging their list */
  async profileStats(): Promise<ProfileStats> {
    const me = await json<{ followers_count?: number }>('dev.to', await this.#fetch(`${this.#base}/users/me`, { headers: this.#headers() }), 'read the account');
    return statsOf({
      // An instance older than the field still counts them by paging
      followers: me.followers_count ?? (await this.#count('/followers/users', 'count the followers')),
      posts: await this.#count('/articles/me/published', 'count the articles'),
    });
  }

  /**
   * What dev.to's own dashboard shows per article and its list does not, from Forem's analytics API
   * with the same key: `saves` (reading-list bookmarks, which the public reactions leave out),
   * `avgReadSeconds` (logged-in readers only), and the views by referrer (its top 20 domains, as
   * `views_<source>`, the blog's names). Two calls an article, spaced for Forem's 40 a minute: read on
   * the channel's analytics cadence, not hourly. A 429 is waited out once (its Retry-After, up to a
   * minute); a second ends the read, keeping what was read and naming the rest in `unread`, so one
   * refusal costs the rest of this read, not what came before it. The `follows` of the totals are the
   * account's, not the article's, and are left to the profile's numbers. An article Forem has no stats
   * for (not published, or not the key's) is left out.
   */
  async analytics(articles: ReadonlyArray<{ id: string }>): Promise<AnalyticsMany> {
    const out: AnalyticsMany = new Map();
    let calls = 0;
    const get = async <T>(path: string, what: string): Promise<T | undefined> => {
      for (let attempt = 0; ; attempt++) {
        if (calls++ > 0 && this.#paceMs > 0) await this.#sleep(this.#paceMs);
        const response = await this.#fetch(`${this.#base}${path}`, { headers: this.#headers() });
        if (response.status === 422 || response.status === 404) return undefined;
        if (response.status === 429) {
          const wait = Number(response.headers.get('retry-after') ?? 60) * 1000;
          if (attempt === 0 && Number.isFinite(wait) && wait <= MAX_RETRY_AFTER_MS) {
            await this.#sleep(Math.max(wait, 0));
            continue;
          }
        }
        return json<T>('dev.to', response, what);
      }
    };
    for (const [i, { id }] of articles.entries()) {
      const query = `article_id=${encodeURIComponent(id)}`;
      try {
        const totals = await get<ForemTotals>(`/analytics/totals?${query}`, 'read the analytics');
        if (!totals) continue;
        const values: Metrics = {};
        if (totals.reactions?.readinglist !== undefined) values.saves = totals.reactions.readinglist;
        if (totals.page_views?.average_read_time_in_seconds !== undefined) values.avgReadSeconds = totals.page_views.average_read_time_in_seconds;
        const referrers = await get<{ domains?: Array<{ domain: string | null; count: number }> }>(`/analytics/referrers?${query}`, 'read the referrers');
        for (const { domain, count } of referrers?.domains ?? []) {
          const name = `views_${sourceOfReferrer(domain)}`;
          values[name] = (values[name] ?? 0) + count;
        }
        out.set(id, values);
      } catch (error) {
        if (!(error instanceof ConnectorError) || error.status !== 429) throw error;
        out.unread = articles.slice(i).map((a) => a.id);
        out.problems = [`${error.message} (${out.unread.length} left for the next read)`];
        break;
      }
    }
    return out;
  }

  /**
   * The author's own list, every article with its counts, ten pages of 100 at most: one call for a
   * hundred articles, whatever number of them a run asks about.
   */
  async #mine(): Promise<Array<{ id: number; page_views_count: number; public_reactions_count: number; comments_count: number }>> {
    const all: Array<{ id: number; page_views_count: number; public_reactions_count: number; comments_count: number }> = [];
    for (let page = 1; page <= 10; page++) {
      const response = await this.#fetch(`${this.#base}/articles/me/all?per_page=100&page=${page}`, { headers: this.#headers() });
      const articles = await json<typeof all>('dev.to', response, 'metrics');
      all.push(...articles);
      if (articles.length < 100) break;
    }
    return all;
  }

  /** The numbers of many articles from one read of the author's list; an article not on it is left out */
  async metricsMany(ids: readonly string[]): Promise<Map<string, Metrics>> {
    const wanted = new Set(ids);
    const out = new Map<string, Metrics>();
    for (const a of await this.#mine()) {
      if (wanted.has(String(a.id))) out.set(String(a.id), { views: a.page_views_count, reactions: a.public_reactions_count, comments: a.comments_count });
    }
    return out;
  }

  /**
   * Each of the author's articles with how many comments it has, from one read of the list: Forem has
   * no notifications API, so a count that moved is what says an article has comments to read.
   */
  async commentCounts(): Promise<Map<string, number>> {
    return new Map((await this.#mine()).map((a) => [String(a.id), a.comments_count]));
  }

  /** Views are only visible to the author, so they come from the author's list, not the public article. */
  async metrics(externalId: string): Promise<Metrics> {
    for (let page = 1; page <= 10; page++) {
      const response = await this.#fetch(`${this.#base}/articles/me/all?per_page=100&page=${page}`, { headers: this.#headers() });
      const articles = await json<
        Array<{ id: number; page_views_count: number; public_reactions_count: number; comments_count: number }>
      >('dev.to', response, 'metrics');
      const found = articles.find((a) => String(a.id) === externalId);
      if (found) {
        return { views: found.page_views_count, reactions: found.public_reactions_count, comments: found.comments_count };
      }
      if (articles.length < 100) break;
    }
    return {};
  }
}
