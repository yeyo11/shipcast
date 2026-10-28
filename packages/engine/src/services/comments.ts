import {
  dismissComment,
  editReplyDraft,
  readCommentSettings,
  sendReply,
  writeCommentSettings,
  type CommentDeps,
  type CommentSettings,
} from '../comments.ts';
import type { CommentListing, CommentStore, SettingStore } from '../ports.ts';
import type { CommentFilter, CommentPageFilter, CommentRecord } from '../registry.ts';

/**
 * The comment assistant as the owner drives it (docs/comments.md): the list, a reply's draft
 * written by hand, its approval (sent with the account the post went out with), a dismissal, and
 * each channel's reply mode. The comments page and the REST API both come here. Reading the
 * networks and drafting with the AI are jobs, queued by the runtime, not use cases of a request.
 */
export class CommentService {
  readonly #store: CommentStore & CommentListing & SettingStore;
  readonly #sending: () => Promise<CommentDeps>;

  constructor(deps: { store: CommentStore & CommentListing & SettingStore; sending: () => Promise<CommentDeps> }) {
    this.#store = deps.store;
    this.#sending = deps.sending;
  }

  /** The comments the filter matches, the newest first */
  list(filter: CommentFilter): Promise<CommentRecord[]> {
    return this.#store.comments.comments(filter);
  }

  /** One page of the comments page, with what its filters can offer: the channels, states and, for a launch, its posts */
  async page(filter: CommentPageFilter) {
    const [page, facets, posts] = await Promise.all([
      this.#store.comments.commentsPage(filter),
      this.#store.comments.commentFacets(filter.own ?? false),
      filter.launchId ? this.#store.comments.commentPosts(filter.launchId, filter.own ?? false) : Promise.resolve([]),
    ]);
    return { page, facets: { ...facets, posts } };
  }

  /** The owner's own words for a reply, replacing the draft; it waits for approval */
  editDraft(commentId: number, draft: string): Promise<CommentRecord> {
    return editReplyDraft(commentId, draft, this.#store);
  }

  /** Approves a reply: sent now, once, with the account the post went out with */
  async send(commentId: number): Promise<CommentRecord> {
    return sendReply(commentId, await this.#sending());
  }

  dismiss(commentId: number): Promise<CommentRecord> {
    return dismissComment(commentId, this.#store);
  }

  settings(): Promise<CommentSettings> {
    return readCommentSettings(this.#store);
  }

  /** Sets the reply modes given; a channel left out keeps its mode */
  saveSettings(input: unknown): Promise<CommentSettings> {
    return writeCommentSettings(this.#store, input);
  }
}
