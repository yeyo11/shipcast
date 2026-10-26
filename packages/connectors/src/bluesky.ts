import {
  checkProblem,
  ConnectorError,
  expectOk,
  imageUrl,
  json,
  okCheck,
  PostGone,
  statsOf,
  type Check,
  type Comment,
  type CommentReader,
  type Deletable,
  type Metrics,
  type ProfileStats,
  type Published,
  type Replier,
  type ReplyTarget,
  type SentReply,
} from './http.ts';

/** A node of app.bsky.feed.getPostThread; a blocked or deleted reply has no `post` */
interface ThreadView {
  post?: {
    uri: string;
    cid: string;
    author: { did: string; handle: string; displayName?: string; avatar?: string };
    record: { text?: string; createdAt?: string; reply?: { parent: { uri: string } } };
    indexedAt?: string;
  };
  replies?: ThreadView[];
}

export interface BlueskyPost {
  text: string;
  lang: string;
  /** The article the post links to, shown as a card */
  link?: { url: string; title: string; description: string; thumb?: { bytes: Uint8Array; mimeType: string } };
}

interface Session {
  did: string;
  handle: string;
  accessJwt: string;
}

interface BlueskyProfile {
  avatar?: string;
  displayName?: string;
  followersCount?: number;
  followsCount?: number;
  postsCount?: number;
}

const URL_RE =/https?:\/\/[^\s)]+/g;

/**
 * Link facets: Bluesky does not detect URLs in a post's text, so each one is declared with its range
 * in UTF-8 bytes (not characters: an accent or an emoji before the link shifts it).
 */
export function linkFacets(text: string): Array<{ index: { byteStart: number; byteEnd: number }; features: unknown[] }> {
  const encoder = new TextEncoder();
  const facets = [];
  for (const match of text.matchAll(URL_RE)) {
    const url = match[0].replace(/[.,;:!?]+$/, '');
    const byteStart = encoder.encode(text.slice(0, match.index)).length;
    facets.push({
      index: { byteStart, byteEnd: byteStart + encoder.encode(url).length },
      features: [{ $type: 'app.bsky.richtext.facet#link', uri: url }],
    });
  }
  return facets;
}

/**
 * Bluesky through the AT Protocol: a session from the handle and an app password, a post record with
 * link facets and a link card, and its counts read from the public AppView, which needs no login.
 */
export class Bluesky implements Deletable, CommentReader, Replier {
  readonly #identifier: string;
  readonly #password: string;
  readonly #fetch: typeof fetch;
  readonly #service: string;
  readonly #appView: string;
  #session: Session | undefined;

  constructor(options: { identifier: string; appPassword: string; fetch?: typeof fetch; service?: string; appView?: string }) {
    this.#identifier = options.identifier;
    this.#password = options.appPassword;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#service = options.service ?? 'https://bsky.social';
    this.#appView = options.appView ?? 'https://public.api.bsky.app';
  }

  async #login(): Promise<Session> {
    if (this.#session) return this.#session;
    const response = await this.#fetch(`${this.#service}/xrpc/com.atproto.server.createSession`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: this.#identifier, password: this.#password }),
    });
    this.#session = await json<Session>('Bluesky', response, 'login');
    return this.#session;
  }

  async publish(post: BlueskyPost): Promise<Published> {
    const session = await this.#login();
    const auth = { authorization: `Bearer ${session.accessJwt}` };

    let embed: unknown;
    if (post.link) {
      let thumb: unknown;
      if (post.link.thumb) {
        const uploaded = await this.#fetch(`${this.#service}/xrpc/com.atproto.repo.uploadBlob`, {
          method: 'POST',
          headers: { ...auth, 'content-type': post.link.thumb.mimeType },
          // The cast tells the DOM's types (the web app compiles this file too) that the bytes are a plain buffer
          body: post.link.thumb.bytes as Uint8Array<ArrayBuffer>,
        });
        thumb = (await json<{ blob: unknown }>('Bluesky', uploaded, 'upload the card image')).blob;
      }
      embed = {
        $type: 'app.bsky.embed.external',
        external: { uri: post.link.url, title: post.link.title, description: post.link.description, ...(thumb ? { thumb } : {}) },
      };
    }

    const response = await this.#fetch(`${this.#service}/xrpc/com.atproto.repo.createRecord`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({
        repo: session.did,
        collection: 'app.bsky.feed.post',
        record: {
          $type: 'app.bsky.feed.post',
          text: post.text,
          createdAt: new Date().toISOString(),
          langs: [post.lang],
          facets: linkFacets(post.text),
          ...(embed ? { embed } : {}),
        },
      }),
    });
    const created = await json<{ uri: string }>('Bluesky', response, 'publish');
    const rkey = created.uri.split('/').at(-1);
    if (!rkey) throw new ConnectorError('Bluesky', `unexpected record uri ${created.uri}`);
    return { externalId: created.uri, url: `https://bsky.app/profile/${session.handle}/post/${rkey}` };
  }

  /**
   * Deletes the post record named by its at:// URI (`at://<did>/<collection>/<rkey>`). Bluesky has
   * no edit: a post can only be deleted and posted again, which loses its likes and replies, so
   * Shipcast never does that on its own.
   */
  async delete(externalId: string): Promise<void> {
    const match = /^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(externalId);
    if (!match) throw new ConnectorError('Bluesky', `${externalId} is not an at:// record URI`, 400);
    const [, repo, collection, rkey] = match;
    const session = await this.#login();
    const response = await this.#fetch(`${this.#service}/xrpc/com.atproto.repo.deleteRecord`, {
      method: 'POST',
      headers: { authorization: `Bearer ${session.accessJwt}`, 'content-type': 'application/json' },
      body: JSON.stringify({ repo, collection, rkey }),
    });
    await expectOk('Bluesky', response, 'delete');
  }

  /**
   * The replies under a post, threads included, from the public AppView's thread view (no session
   * needed). A reply whose author blocked the reader, or that was deleted, comes back as a stub with
   * no post, and is left out. The post itself deleted is a 400 `NotFound`, which is PostGone.
   */
  async comments(externalId: string): Promise<Comment[]> {
    const query = new URLSearchParams({ uri: externalId, depth: '10', parentHeight: '0' });
    const { thread } = await json<{ thread: ThreadView }>('Bluesky', await this.#fetch(`${this.#appView}/xrpc/app.bsky.feed.getPostThread?${query}`), 'read the replies').catch((error: unknown) => {
      if (error instanceof ConnectorError && error.status === 400 && error.message.includes('"error":"NotFound"')) throw new PostGone('Bluesky', `the post ${externalId} no longer exists`, 400);
      throw error;
    });
    const owner = thread.post?.author.did;
    const out: Comment[] = [];
    const visit = (node: ThreadView) => {
      for (const child of node.replies ?? []) {
        const post = child.post;
        if (!post) continue;
        const parent = post.record.reply?.parent.uri;
        const rkey = post.uri.split('/').at(-1) ?? '';
        const avatarUrl = imageUrl(post.author.avatar);
        const displayName = post.author.displayName?.trim();
        out.push({
          externalId: post.uri,
          author: { handle: `@${post.author.handle}`, ...(displayName && { displayName }), ...(avatarUrl && { avatarUrl }) },
          text: post.record.text ?? '',
          createdAt: post.record.createdAt ?? post.indexedAt ?? new Date().toISOString(),
          ...(parent && parent !== externalId && { inReplyTo: parent }),
          url: `https://bsky.app/profile/${post.author.handle}/post/${rkey}`,
          own: post.author.did === owner,
        });
        visit(child);
      }
    };
    visit(thread);
    return out;
  }

  /**
   * A reply record: the AT Protocol threads it by strong references (URI and CID) to the thread's
   * root, the post Shipcast published, and to the comment it answers; both CIDs are read from the
   * AppView just before, so nothing extra has to be stored with the comment.
   */
  async reply(target: ReplyTarget, text: string, options: { key?: string; lang?: string } = {}): Promise<SentReply> {
    const query = new URLSearchParams();
    query.append('uris', target.postExternalId);
    query.append('uris', target.commentExternalId);
    const { posts } = await json<{ posts: Array<{ uri: string; cid: string }> }>('Bluesky', await this.#fetch(`${this.#appView}/xrpc/app.bsky.feed.getPosts?${query}`), 'read the thread');
    const root = posts.find((p) => p.uri === target.postExternalId);
    const parent = posts.find((p) => p.uri === target.commentExternalId);
    if (!root || !parent) throw new ConnectorError('Bluesky', 'the post or the comment is gone: nothing to reply to', 404);
    const session = await this.#login();
    const response = await this.#fetch(`${this.#service}/xrpc/com.atproto.repo.createRecord`, {
      method: 'POST',
      headers: { authorization: `Bearer ${session.accessJwt}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        repo: session.did,
        collection: 'app.bsky.feed.post',
        record: {
          $type: 'app.bsky.feed.post',
          text,
          createdAt: new Date().toISOString(),
          ...(options.lang && { langs: [options.lang] }),
          facets: linkFacets(text),
          reply: { root: { uri: root.uri, cid: root.cid }, parent: { uri: parent.uri, cid: parent.cid } },
        },
      }),
    });
    const created = await json<{ uri: string }>('Bluesky', response, 'reply');
    return { externalId: created.uri, url: `https://bsky.app/profile/${session.handle}/post/${created.uri.split('/').at(-1) ?? ''}` };
  }

  /** The public profile from the AppView, which needs no session: picture, name and counts */
  async #profile(actor: string): Promise<BlueskyProfile> {
    const response = await this.#fetch(`${this.#appView}/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(actor)}`);
    return json<BlueskyProfile>('Bluesky', response, 'read the profile');
  }

  /**
   * Signs in with the app password: the only way to know it still works. The profile is read after
   * it for the picture; a profile that does not answer leaves the check working, without one.
   */
  async check(): Promise<Check> {
    let session: Session;
    try {
      this.#session = undefined;
      session = await this.#login();
    } catch (error) {
      return checkProblem(error);
    }
    const profile = await this.#profile(session.did).catch(() => undefined);
    return okCheck(`@${session.handle}`, { avatarUrl: profile?.avatar, displayName: profile?.displayName });
  }

  async profileStats(): Promise<ProfileStats> {
    const profile = await this.#profile(this.#session?.did ?? this.#identifier);
    return statsOf({ followers: profile.followersCount, following: profile.followsCount, posts: profile.postsCount });
  }

  async metrics(externalId: string): Promise<Metrics> {
    const response = await this.#fetch(`${this.#appView}/xrpc/app.bsky.feed.getPosts?uris=${encodeURIComponent(externalId)}`);
    const { posts } = await json<{ posts: Array<{ likeCount?: number; repostCount?: number; replyCount?: number; quoteCount?: number }> }>(
      'Bluesky',
      response,
      'metrics',
    );
    const post = posts[0];
    if (!post) return {};
    return { likes: post.likeCount ?? 0, reposts: post.repostCount ?? 0, replies: post.replyCount ?? 0, quotes: post.quoteCount ?? 0 };
  }
}
