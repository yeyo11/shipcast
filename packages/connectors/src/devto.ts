import { checkProblem, json, okCheck, statsOf, type Check, type Metrics, type ProfileStats, type Published } from './http.ts';

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
 * and its views, reactions and comments read back from the author's own list.
 */
export class Devto {
  readonly #key: string;
  readonly #fetch: typeof fetch;
  readonly #base: string;

  constructor(options: { apiKey: string; fetch?: typeof fetch; baseUrl?: string }) {
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

  async profileStats(): Promise<ProfileStats> {
    return statsOf({
      followers: await this.#count('/followers/users', 'count the followers'),
      posts: await this.#count('/articles/me/published', 'count the articles'),
    });
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
