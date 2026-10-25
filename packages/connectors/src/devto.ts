import { checkProblem, expectOk, htmlToText, imageUrl, json, okCheck, statsOf, type Check, type Comment, type CommentReader, type Deletable, type Editable, type Metrics, type ProfileStats, type Published } from './http.ts';

/** What an edit may change; whatever is left out stays as it is */
export type DevtoEdit = Partial<DevtoArticle>;

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
export class Devto implements Editable<DevtoEdit>, Deletable, CommentReader {
  readonly #key: string;
  readonly #fetch: typeof fetch;
  readonly #base: string;
  #username: Promise<string> | undefined;

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
    this.#username ??= this.#fetch(`${this.#base}/users/me`, { headers: this.#headers() })
      .then((response) => json<{ username: string }>('dev.to', response, 'read the account'))
      .then(
        (me) => me.username,
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
