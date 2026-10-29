import {
  checkProblem,
  chunks,
  ConnectorError,
  counts,
  expectOk,
  imageUrl,
  json,
  okCheck,
  statsOf,
  type Check,
  type Deletable,
  type Metrics,
  type Profile,
  type ProfileReader,
  type ProfileStats,
  type Published,
} from './http.ts';

export interface RedditPost {
  /** Without r/ */
  subreddit: string;
  title: string;
  /** Markdown */
  text: string;
}

export interface RedditOptions {
  /** The owner's Reddit app, a "web app": the refresh token is only good with the app that issued it */
  clientId: string;
  clientSecret: string;
  /** Permanent (`duration=permanent`): each use trades it for an access token of an hour */
  refreshToken: string;
  /** The account's name, without u/, for the `User-Agent` Reddit asks for and to find its own submissions */
  username: string;
  fetch?: typeof fetch;
}

/**
 * Reddit's scopes: who the account is, posting, reading posts (their numbers too), listing its own
 * submissions (`history`, which `/user/{name}/submitted` needs) and deleting them (`edit`, "edit and
 * delete my comments and submissions"). `history` and `edit` joined on 2026-10-29: a token granted
 * before lacks them, and finding a lost post or deleting one says to connect again.
 */
export const REDDIT_SCOPES = ['identity', 'submit', 'read', 'history', 'edit'];

const API = 'https://oauth.reddit.com';

/** Reddit refuses requests without a descriptive User-Agent, in its own format */
export function redditUserAgent(username: string): string {
  return `web:dev.shipcast:1 (by /u/${username})`;
}

/** One of the account's own submissions, as its listing shows it */
interface Submission {
  name: string;
  title: string;
  subreddit: string;
  permalink: string;
  created_utc: number;
}

/** A post's counts in `/api/info`; Reddit leaves views out (null) for anyone but the author's own app */
interface PostCounts {
  name: string;
  score?: number;
  num_comments?: number;
  num_crossposts?: number;
  upvote_ratio?: number;
}

/** The account's own page, a subreddit named `u_<name>`: its title, description and pictures */
interface UserSubreddit {
  title?: string;
  public_description?: string;
  icon_img?: string;
  banner_img?: string;
  subscribers?: number;
}

/** Reddit's default avatars (a coloured Snoo) are pictures nobody chose */
const defaultAvatar = (url: string | undefined) => !url || /\/avatar_default_/.test(url);

/** Reddit escapes an image's query string as HTML */
const unescape = (url: string | undefined) => url?.replaceAll('&amp;', '&');

/**
 * Reddit, as the owner's own account through their Reddit app (OAuth, a permanent refresh token):
 * one text post per subreddit, its delete, its numbers and the account's profile. Reddit answers a
 * refused submission with a 200 and a list of errors, so every answer is read for them. A submission
 * the network may have taken without answering (a timeout) is looked for among the account's newest
 * ones before any retry: `find` is how the caller does that, so a post never lands twice.
 */
export class Reddit implements Deletable, ProfileReader {
  readonly #options: RedditOptions;
  readonly #fetch: typeof fetch;
  #token: Promise<{ accessToken: string; scopes: ReadonlySet<string> | undefined }> | undefined;

  constructor(options: RedditOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  get username(): string {
    return this.#options.username;
  }

  /**
   * An access token for this run, and the scopes the account granted (the answer says them): one
   * refresh per connector, since a token lasts an hour
   */
  #accessToken(): Promise<{ accessToken: string; scopes: ReadonlySet<string> | undefined }> {
    this.#token ??= (async () => {
      const { clientId, clientSecret, refreshToken, username } = this.#options;
      const response = await this.#fetch('https://www.reddit.com/api/v1/access_token', {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
          'content-type': 'application/x-www-form-urlencoded',
          'user-agent': redditUserAgent(username),
        },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
      });
      const token = await json<{ access_token?: string; scope?: string; error?: string }>('Reddit', response, 'refresh the token');
      // A revoked or unknown refresh token is a 200 with an error: connecting again is the fix
      if (!token.access_token) throw new ConnectorError('Reddit', `the token was refused (${token.error ?? 'no access token'}): connect the account again from Channels`, 401, false);
      return { accessToken: token.access_token, scopes: typeof token.scope === 'string' ? new Set(token.scope.split(/[\s,]+/).filter(Boolean)) : undefined };
    })();
    this.#token.catch(() => (this.#token = undefined));
    return this.#token;
  }

  /**
   * Refuses, before asking, what the account did not grant: a token connected before Shipcast asked
   * for `history` and `edit` cannot list its submissions or delete them. Said as what to do, never
   * retried. An answer that does not say its scopes is let through, and a 403 then says the same.
   */
  async #needs(scope: string, what: string): Promise<void> {
    const { scopes } = await this.#accessToken();
    if (scopes && !scopes.has(scope) && !scopes.has('*')) throw missingScope(scope, what);
  }

  async #call(path: string, init: { method?: string; form?: Record<string, string> } = {}): Promise<Response> {
    const { accessToken } = await this.#accessToken();
    return this.#fetch(`${API}${path}`, {
      method: init.method ?? (init.form ? 'POST' : 'GET'),
      headers: {
        authorization: `bearer ${accessToken}`,
        'user-agent': redditUserAgent(this.#options.username),
        ...(init.form && { 'content-type': 'application/x-www-form-urlencoded' }),
      },
      ...(init.form && { body: new URLSearchParams(init.form) }),
    });
  }

  /**
   * A text post. Refused submissions (a missing flair, a rule of the subreddit, a title too long)
   * are not retried; a rate limit is.
   */
  async publish(post: RedditPost): Promise<Published> {
    const response = await this.#call('/api/submit', {
      form: { api_type: 'json', kind: 'self', sr: post.subreddit, title: post.title, text: post.text, sendreplies: 'true', resubmit: 'true' },
    });
    const answer = await json<{ json?: { errors?: Array<[string, string, string?]>; data?: { url?: string; name?: string; id?: string } } }>('Reddit', response, `post to r/${post.subreddit}`);
    const errors = answer.json?.errors ?? [];
    if (errors.length > 0) {
      const rateLimited = errors.every((e) => e[0] === 'RATELIMIT');
      throw new ConnectorError('Reddit', `r/${post.subreddit} refused the post: ${errors.map((e) => e[1]).join('; ')}`, rateLimited ? 429 : 400, rateLimited);
    }
    const data = answer.json?.data;
    const name = data?.name ?? (data?.id ? `t3_${data.id}` : undefined);
    // Accepted but unnamed: posting again would post it twice
    if (!name) throw new ConnectorError('Reddit', `r/${post.subreddit} took the post but Reddit returned no id for it`, response.status, false);
    return { externalId: name, url: data?.url ?? `https://www.reddit.com/r/${post.subreddit}/` };
  }

  /**
   * The account's own post with this title in this subreddit, made since a moment: what a submit
   * whose answer was lost left behind. Read-only, so it is safe to ask before every retry. It needs
   * `history`; without it the retry stops here rather than risk posting twice.
   */
  async find(post: Pick<RedditPost, 'subreddit' | 'title'>, since: Date): Promise<Published | undefined> {
    const what = 'look for a post whose answer was lost';
    await this.#needs('history', what);
    const response = await this.#call(`/user/${encodeURIComponent(this.#options.username)}/submitted?limit=25&sort=new&raw_json=1`);
    if (response.status === 403) throw missingScope('history', what);
    const listing = await json<{ data: { children: Array<{ data: Submission }> } }>('Reddit', response, 'read your submissions');
    const sub = post.subreddit.toLowerCase();
    // A minute of slack for the clocks: Reddit stamps the post, Shipcast stamps the attempt
    const after = since.getTime() / 1000 - 60;
    const found = listing.data.children
      .map((c) => c.data)
      .find((s) => s.subreddit.toLowerCase() === sub && s.title === post.title && s.created_utc >= after);
    return found ? { externalId: found.name, url: `https://www.reddit.com${found.permalink}` } : undefined;
  }

  /** Deleting a post that is gone already answers 200 too; it needs `edit` */
  async delete(externalId: string): Promise<void> {
    await this.#needs('edit', 'delete a post');
    const response = await this.#call('/api/del', { form: { id: externalId } });
    if (response.status === 403) throw missingScope('edit', 'delete a post');
    await expectOk('Reddit', response, 'delete');
  }

  /**
   * The numbers of many posts by their names (`t3_…`), 100 per call through `/api/info` (`read`):
   * score, comments, crossposts, and the share of votes that are upvotes, a ratio from 0 to 1 that
   * is averaged across posts, never added up. A post missing from the answer is left out.
   */
  async metricsMany(names: readonly string[]): Promise<Map<string, Metrics>> {
    const out = new Map<string, Metrics>();
    for (const batch of chunks(names, 100)) {
      const query = new URLSearchParams({ id: batch.join(','), raw_json: '1' });
      const listing = await json<{ data?: { children?: Array<{ kind: string; data: PostCounts }> } }>('Reddit', await this.#call(`/api/info?${query}`), 'metrics');
      for (const { kind, data } of listing.data?.children ?? []) {
        if (kind !== 't3') continue;
        out.set(data.name, counts({ score: data.score, comments: data.num_comments, crossposts: data.num_crossposts, upvoteRatio: data.upvote_ratio }));
      }
    }
    return out;
  }

  async metrics(externalId: string): Promise<Metrics> {
    return (await this.metricsMany([externalId])).get(externalId) ?? {};
  }

  async #me(): Promise<{ name: string; icon_img?: string; total_karma?: number; subreddit?: UserSubreddit }> {
    return json('Reddit', await this.#call('/api/v1/me'), 'check');
  }

  async check(): Promise<Check> {
    try {
      const me = await this.#me();
      if (me.name.toLowerCase() !== this.#options.username.toLowerCase()) return { ok: false, problem: `the token belongs to u/${me.name}, not to u/${this.#options.username}` };
      return okCheck(`u/${me.name}`, { avatarUrl: unescape(me.icon_img), displayName: `u/${me.name}` });
    } catch (error) {
      return checkProblem(error);
    }
  }

  /**
   * The profile from `/api/v1/me` (`identity`): the account's page is a subreddit of its own, whose
   * title is the display name and whose public description is the About text. Reddit's social links
   * are not in its API, so there are none here.
   */
  async profile(): Promise<Profile> {
    const me = await this.#me();
    const page = me.subreddit ?? {};
    const avatar = unescape(page.icon_img || me.icon_img);
    return {
      ...(page.title?.trim() && { displayName: page.title.trim() }),
      ...(page.public_description?.trim() && { bio: page.public_description }),
      links: [],
      hasAvatar: !defaultAvatar(avatar) && imageUrl(avatar) !== undefined,
      hasBanner: imageUrl(unescape(page.banner_img)) !== undefined,
    };
  }

  /** The profile's followers, Reddit's subscribers to the user's own page */
  async profileStats(): Promise<ProfileStats> {
    const me = await this.#me();
    return statsOf({ followers: me.subreddit?.subscribers }, { karma: me.total_karma });
  }
}

/** A token granted before Shipcast asked for this scope: connecting again is the fix */
function missingScope(scope: string, what: string): ConnectorError {
  return new ConnectorError('Reddit', `the token was not granted ${scope}, which it takes to ${what}: connect the account again from Channels`, 403, false);
}
