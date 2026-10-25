import { ConnectorError, json, checkProblem, okCheck, statsOf, type Check, type Deletable, type Editable, type Metrics, type ProfileStats, type Published } from './http.ts';

export interface HashnodeArticle {
  title: string;
  markdown: string;
  tags: string[];
  /** The blog's URL of the same article: Hashnode keeps it as the original so the blog stays canonical */
  canonicalUrl: string;
  coverImageUrl?: string;
}

/** What an edit may change; whatever is left out stays as it is */
export type HashnodeEdit = Partial<HashnodeArticle>;

interface GraphQLAnswer<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
}

/** Hashnode wants a slug and a name for each tag. */
function tagInput(name: string): { slug: string; name: string } {
  return { slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''), name };
}

/**
 * Hashnode through its GraphQL API: an article published to the publication with `originalArticleURL`
 * set to the blog, and its views, reactions and comments read back. Since May 2026 the API answers
 * only publications on the Pro plan. A post can be edited (`updatePost`) and removed (`removePost`).
 */
export class Hashnode implements Editable<HashnodeEdit>, Deletable {
  readonly #token: string;
  #publicationId: string | undefined;
  readonly #publicationHost: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #base: string;

  constructor(options: { token: string; publicationId?: string; publicationHost?: string; fetch?: typeof fetch; baseUrl?: string }) {
    this.#token = options.token;
    this.#publicationId = options.publicationId;
    this.#publicationHost = options.publicationHost;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#base = options.baseUrl ?? 'https://gql.hashnode.com';
  }

  /** GraphQL reports most failures as a 200 with `errors`, so they are mapped back to the status they mean. */
  async #query<T>(what: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const response = await this.#fetch(this.#base, {
      method: 'POST',
      // The token goes bare, with no "Bearer": that is how Hashnode reads it
      headers: { authorization: this.#token, 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    const answer = await json<GraphQLAnswer<T>>('Hashnode', response, what);
    const error = answer.errors?.[0];
    if (error || !answer.data) {
      const code = error?.extensions?.code;
      const status = code === 'UNAUTHENTICATED' ? 401 : code === 'FORBIDDEN' ? 403 : 400;
      throw new ConnectorError('Hashnode', `${what}: ${error?.message ?? 'empty answer'}`, status);
    }
    return answer.data;
  }

  async #publication(): Promise<string> {
    if (this.#publicationId) return this.#publicationId;
    if (!this.#publicationHost) throw new ConnectorError('Hashnode', 'a publicationId or a publicationHost is needed to publish', 400);
    const data = await this.#query<{ publication: { id: string } | null }>(
      'find the publication',
      'query($host: String!) { publication(host: $host) { id } }',
      { host: this.#publicationHost },
    );
    if (!data.publication) throw new ConnectorError('Hashnode', `no publication at ${this.#publicationHost}`, 404);
    this.#publicationId = data.publication.id;
    return this.#publicationId;
  }

  async publish(article: HashnodeArticle): Promise<Published> {
    const data = await this.#query<{ publishPost: { post: { id: string; url: string } } }>(
      'publish',
      'mutation($input: PublishPostInput!) { publishPost(input: $input) { post { id url } } }',
      {
        input: {
          publicationId: await this.#publication(),
          title: article.title,
          contentMarkdown: article.markdown,
          tags: article.tags.map(tagInput),
          originalArticleURL: article.canonicalUrl,
          ...(article.coverImageUrl ? { coverImageOptions: { coverImageURL: article.coverImageUrl } } : {}),
        },
      },
    );
    const { id, url } = data.publishPost.post;
    return { externalId: id, url };
  }

  async edit(externalId: string, edit: HashnodeEdit): Promise<void> {
    await this.#query<{ updatePost: { post: { id: string } } }>(
      'edit',
      'mutation($input: UpdatePostInput!) { updatePost(input: $input) { post { id } } }',
      {
        input: {
          id: externalId,
          ...(edit.title !== undefined && { title: edit.title }),
          ...(edit.markdown !== undefined && { contentMarkdown: edit.markdown }),
          ...(edit.tags !== undefined && { tags: edit.tags.map(tagInput) }),
          ...(edit.canonicalUrl !== undefined && { originalArticleURL: edit.canonicalUrl }),
          ...(edit.coverImageUrl !== undefined && { coverImageOptions: { coverImageURL: edit.coverImageUrl } }),
        },
      },
    );
  }

  async delete(externalId: string): Promise<void> {
    await this.#query<{ removePost: { post: { id: string } | null } }>(
      'delete',
      'mutation($input: RemovePostInput!) { removePost(input: $input) { post { id } } }',
      { input: { id: externalId } },
    );
  }

  async metrics(externalId: string): Promise<Metrics> {
    const data = await this.#query<{ post: { views: number; reactionCount: number; responseCount: number } | null }>(
      'metrics',
      'query($id: ID!) { post(id: $id) { views reactionCount responseCount } }',
      { id: externalId },
    );
    if (!data.post) return {};
    return { views: data.post.views, reactions: data.post.reactionCount, comments: data.post.responseCount };
  }

  async check(): Promise<Check> {
    try {
      const data = await this.#query<{ me: { username: string; name?: string; profilePicture?: string | null } }>('check', 'query { me { username name profilePicture } }');
      if (this.#publicationHost || this.#publicationId) await this.#publication();
      return okCheck(data.me.username, { avatarUrl: data.me.profilePicture, displayName: data.me.name });
    } catch (error) {
      return checkProblem(error, 'the token was rejected, or the publication is not on the Pro plan the API now needs');
    }
  }

  async profileStats(): Promise<ProfileStats> {
    const { me } = await this.#query<{ me: { followersCount?: number; followingsCount?: number; posts?: { totalDocuments?: number } } }>(
      'read the profile',
      'query { me { followersCount followingsCount posts(pageSize: 1, page: 1) { totalDocuments } } }',
    );
    return statsOf({ followers: me.followersCount, following: me.followingsCount, posts: me.posts?.totalDocuments });
  }
}
