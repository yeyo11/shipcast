import {
  ConnectorError,
  imageUrl,
  type Comment,
  type CommentReader,
  type Deletable,
  type Editable,
  type Metrics,
  type Published,
  type Replier,
  type ReplyTarget,
  type SentReply,
} from './http.ts';

const NETWORK = 'GitHub Discussions';

/** Something that hands out a GitHub token per request: the GitHub App's installation, or a constant */
export interface GitHubTokenSource {
  token(): Promise<string>;
  /** Forgets a token GitHub refused, so the next request mints a fresh one */
  invalidate?(): void;
}

export interface GitHubDiscussionsOptions {
  auth: GitHubTokenSource;
  fetch?: typeof fetch;
  /** The GraphQL endpoint; GitHub Enterprise has its own */
  endpoint?: string;
  /** The categories tried in order; the first the repo has is used */
  categories?: readonly string[];
}

export interface DiscussionPost {
  /** `owner/name`: the launched repo, where its own community reads it */
  repo: string;
  title: string;
  /** Markdown */
  body: string;
}

export interface DiscussionEdit {
  title?: string;
  body?: string;
}

/** Announcements is GitHub's category for maintainers' news (only maintainers can post there); General exists in every repo with Discussions on */
export const DISCUSSION_CATEGORIES = ['Announcements', 'General'] as const;

interface GraphQlError {
  type?: string;
  message: string;
}

interface DiscussionComment {
  id: string;
  body: string;
  createdAt: string;
  url: string;
  viewerDidAuthor: boolean;
  authorAssociation: string;
  author: { login: string; avatarUrl?: string } | null;
}

const COMMENT_FIELDS = 'id body createdAt url viewerDidAuthor authorAssociation author { login avatarUrl }';

/**
 * GitHub Discussions over the GraphQL API, with the engine's own GitHub access (the GitHub App's
 * installation token, which has Discussions: write), so there is no account to connect. A discussion
 * goes in the launched repo's Announcements category, or General when it has none. A repo with
 * Discussions turned off is said in words the owner can act on, never as a GraphQL error.
 */
export class GitHubDiscussions implements Editable<DiscussionEdit>, Deletable, CommentReader, Replier {
  readonly #auth: GitHubTokenSource;
  readonly #fetch: typeof fetch;
  readonly #endpoint: string;
  readonly #categories: readonly string[];

  constructor(options: GitHubDiscussionsOptions) {
    this.#auth = options.auth;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#endpoint = options.endpoint ?? 'https://api.github.com/graphql';
    this.#categories = options.categories ?? DISCUSSION_CATEGORIES;
  }

  /** One query; a 401 is tried once more with a fresh token, as the engine's REST client does */
  async #query<T>(query: string, variables: Record<string, unknown>, what: string): Promise<T> {
    const send = async () =>
      this.#fetch(this.#endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${await this.#auth.token()}`, 'content-type': 'application/json', 'user-agent': 'shipcast' },
        body: JSON.stringify({ query, variables }),
      });
    let response = await send();
    if (response.status === 401 && this.#auth.invalidate) {
      this.#auth.invalidate();
      response = await send();
    }
    const text = await response.text();
    if (!response.ok) throw new ConnectorError(NETWORK, `${what}: ${response.status} ${text.slice(0, 300)}`, response.status);
    let answer: { data?: T | null; errors?: GraphQlError[] };
    try {
      answer = JSON.parse(text) as typeof answer;
    } catch {
      throw new ConnectorError(NETWORK, `${what}: the answer is not JSON`, response.status);
    }
    const [first] = answer.errors ?? [];
    if (first) {
      // GraphQL answers 200 with its errors: the ones that will not change on a retry are said so
      const status = first.type === 'NOT_FOUND' ? 404 : first.type === 'FORBIDDEN' || /not accessible by integration/i.test(first.message) ? 403 : 422;
      throw new ConnectorError(NETWORK, `${what}: ${first.message}`, status);
    }
    if (!answer.data) throw new ConnectorError(NETWORK, `${what}: no data in the answer`, response.status);
    return answer.data;
  }

  /** The repo's id and the category to post in; refuses, in words, a repo with Discussions off */
  async #target(repo: string): Promise<{ repositoryId: string; categoryId: string; category: string }> {
    const [owner, name] = repo.split('/');
    if (!owner || !name) throw new ConnectorError(NETWORK, `${repo} is not owner/name`, undefined, false);
    type Answer = { repository: { id: string; hasDiscussionsEnabled: boolean; discussionCategories: { nodes: Array<{ id: string; name: string }> } } | null };
    const { repository } = await this.#query<Answer>(
      'query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id hasDiscussionsEnabled discussionCategories(first: 50) { nodes { id name } } } }',
      { owner, name },
      `read ${repo}`,
    );
    if (!repository) throw new ConnectorError(NETWORK, `${repo} cannot be read: install the GitHub App on it`, 404, false);
    if (!repository.hasDiscussionsEnabled) {
      // Not worth retrying every round: nothing changes until the owner turns them on
      throw new ConnectorError(NETWORK, `Discussions are turned off in ${repo}: enable Discussions in the repo settings (Settings → General → Features), then retry the channel`, 409, false);
    }
    const categories = repository.discussionCategories.nodes;
    for (const wanted of this.#categories) {
      const found = categories.find((c) => c.name.toLowerCase() === wanted.toLowerCase());
      if (found) return { repositoryId: repository.id, categoryId: found.id, category: found.name };
    }
    throw new ConnectorError(NETWORK, `${repo} has no ${this.#categories.join(' or ')} discussion category: add one in the repo's Discussions`, 409, false);
  }

  /** Whether the repo can take a discussion, and in which category; what a check or a test shows */
  async category(repo: string): Promise<string> {
    return (await this.#target(repo)).category;
  }

  async publish(post: DiscussionPost): Promise<Published> {
    const target = await this.#target(post.repo);
    type Answer = { createDiscussion: { discussion: { id: string; url: string } } };
    const { createDiscussion } = await this.#query<Answer>(
      'mutation($input: CreateDiscussionInput!) { createDiscussion(input: $input) { discussion { id url } } }',
      { input: { repositoryId: target.repositoryId, categoryId: target.categoryId, title: post.title, body: post.body } },
      'create the discussion',
    );
    return { externalId: createDiscussion.discussion.id, url: createDiscussion.discussion.url };
  }

  async edit(externalId: string, edit: DiscussionEdit): Promise<void> {
    if (edit.title === undefined && edit.body === undefined) return;
    await this.#query(
      'mutation($input: UpdateDiscussionInput!) { updateDiscussion(input: $input) { discussion { id } } }',
      { input: { discussionId: externalId, ...(edit.title !== undefined && { title: edit.title }), ...(edit.body !== undefined && { body: edit.body }) } },
      'update the discussion',
    );
  }

  async delete(externalId: string): Promise<void> {
    await this.#query('mutation($input: DeleteDiscussionInput!) { deleteDiscussion(input: $input) { discussion { id } } }', { input: { id: externalId } }, 'delete the discussion');
  }

  /** Reactions, upvotes and comments, which the discussion itself counts */
  async metrics(externalId: string): Promise<Metrics> {
    type Answer = { node: { upvoteCount: number; reactions: { totalCount: number }; comments: { totalCount: number } } | null };
    const { node } = await this.#query<Answer>(
      'query($id: ID!) { node(id: $id) { ... on Discussion { upvoteCount reactions { totalCount } comments { totalCount } } } }',
      { id: externalId },
      'metrics',
    );
    if (!node) throw new ConnectorError(NETWORK, 'metrics: the discussion is gone', 404);
    return { reactions: node.reactions.totalCount, upvotes: node.upvoteCount, comments: node.comments.totalCount };
  }

  /**
   * The comments and their replies, the first hundred of each (a launch's discussion is not a forum).
   * The App's own comments are Shipcast's replies; the repo owner's are the owner's own words, kept
   * for the thread and never answered.
   */
  async comments(externalId: string): Promise<Comment[]> {
    type Answer = { node: { comments: { nodes: Array<DiscussionComment & { replies: { nodes: DiscussionComment[] } }> } } | null };
    const { node } = await this.#query<Answer>(
      `query($id: ID!) { node(id: $id) { ... on Discussion { comments(first: 100) { nodes { ${COMMENT_FIELDS} replies(first: 100) { nodes { ${COMMENT_FIELDS} } } } } } } }`,
      { id: externalId },
      'read the comments',
    );
    if (!node) throw new ConnectorError(NETWORK, 'read the comments: the discussion is gone', 404);
    const out: Comment[] = [];
    const add = (c: DiscussionComment, parent?: string) => {
      const avatarUrl = imageUrl(c.author?.avatarUrl);
      out.push({
        externalId: c.id,
        author: { handle: `@${c.author?.login ?? 'ghost'}`, ...(avatarUrl && { avatarUrl }) },
        text: c.body,
        createdAt: c.createdAt,
        url: c.url,
        ...(parent && { inReplyTo: parent }),
        own: c.viewerDidAuthor || c.authorAssociation === 'OWNER',
      });
    };
    for (const comment of node.comments.nodes) {
      add(comment);
      for (const reply of comment.replies.nodes) add(reply, comment.id);
    }
    return out;
  }

  /**
   * A reply in the comment's thread. GitHub nests one level only, so a reply to a reply goes under
   * the comment that thread hangs from. It is written by the App's bot, not by the owner's account.
   */
  async reply(target: ReplyTarget, text: string): Promise<SentReply> {
    type Parent = { node: { replyTo: { id: string } | null } | null };
    const { node } = await this.#query<Parent>('query($id: ID!) { node(id: $id) { ... on DiscussionComment { replyTo { id } } } }', { id: target.commentExternalId }, 'read the comment');
    const replyToId = node?.replyTo?.id ?? target.commentExternalId;
    type Answer = { addDiscussionComment: { comment: { id: string; url: string } } };
    const { addDiscussionComment } = await this.#query<Answer>(
      'mutation($input: AddDiscussionCommentInput!) { addDiscussionComment(input: $input) { comment { id url } } }',
      { input: { discussionId: target.postExternalId, replyToId, body: text } },
      'reply',
    );
    return { externalId: addDiscussionComment.comment.id, url: addDiscussionComment.comment.url };
  }
}
