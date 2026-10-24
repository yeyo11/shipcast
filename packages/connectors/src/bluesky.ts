import { ConnectorError, json, type Metrics, type Published } from './http.ts';

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

const URL_RE = /https?:\/\/[^\s)]+/g;

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
export class Bluesky {
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
          body: post.link.thumb.bytes,
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
