import { checkProblem, ConnectorError, expectOk, json, okCheck, statsOf, type Check, type Deletable, type ProfileStats, type Published } from './http.ts';

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

/** Reddit's scopes: who the account is, posting, and reading its own submissions back */
export const REDDIT_SCOPES = ['identity', 'submit', 'read'];

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

/**
 * Reddit, as the owner's own account through their Reddit app (OAuth, a permanent refresh token):
 * one text post per subreddit, and its delete. Reddit answers a refused submission with a 200 and
 * a list of errors, so every answer is read for them. A submission the network may have taken
 * without answering (a timeout) is looked for among the account's newest ones before any retry:
 * `find` is how the caller does that, so a post never lands twice.
 */
export class Reddit implements Deletable {
  readonly #options: RedditOptions;
  readonly #fetch: typeof fetch;
  #token: Promise<string> | undefined;

  constructor(options: RedditOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  get username(): string {
    return this.#options.username;
  }

  /** An access token for this run: one refresh per connector, since a token lasts an hour */
  #accessToken(): Promise<string> {
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
      const token = await json<{ access_token?: string; error?: string }>('Reddit', response, 'refresh the token');
      // A revoked or unknown refresh token is a 200 with an error: connecting again is the fix
      if (!token.access_token) throw new ConnectorError('Reddit', `the token was refused (${token.error ?? 'no access token'}): connect the account again from Channels`, 401, false);
      return token.access_token;
    })();
    this.#token.catch(() => (this.#token = undefined));
    return this.#token;
  }

  async #call(path: string, init: { method?: string; form?: Record<string, string> } = {}): Promise<Response> {
    const token = await this.#accessToken();
    return this.#fetch(`${API}${path}`, {
      method: init.method ?? (init.form ? 'POST' : 'GET'),
      headers: {
        authorization: `bearer ${token}`,
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
   * whose answer was lost left behind. Read-only, so it is safe to ask before every retry.
   */
  async find(post: Pick<RedditPost, 'subreddit' | 'title'>, since: Date): Promise<Published | undefined> {
    const response = await this.#call(`/user/${encodeURIComponent(this.#options.username)}/submitted?limit=25&sort=new&raw_json=1`);
    const listing = await json<{ data: { children: Array<{ data: Submission }> } }>('Reddit', response, 'read your submissions');
    const sub = post.subreddit.toLowerCase();
    // A minute of slack for the clocks: Reddit stamps the post, Shipcast stamps the attempt
    const after = since.getTime() / 1000 - 60;
    const found = listing.data.children
      .map((c) => c.data)
      .find((s) => s.subreddit.toLowerCase() === sub && s.title === post.title && s.created_utc >= after);
    return found ? { externalId: found.name, url: `https://www.reddit.com${found.permalink}` } : undefined;
  }

  /** Deleting a post that is gone already answers 200 too */
  async delete(externalId: string): Promise<void> {
    const response = await this.#call('/api/del', { form: { id: externalId } });
    await expectOk('Reddit', response, 'delete');
  }

  async #me(): Promise<{ name: string; icon_img?: string; total_karma?: number; subreddit?: { subscribers?: number } }> {
    return json('Reddit', await this.#call('/api/v1/me'), 'check');
  }

  async check(): Promise<Check> {
    try {
      const me = await this.#me();
      if (me.name.toLowerCase() !== this.#options.username.toLowerCase()) return { ok: false, problem: `the token belongs to u/${me.name}, not to u/${this.#options.username}` };
      // Reddit escapes the picture's query string as HTML
      return okCheck(`u/${me.name}`, { avatarUrl: me.icon_img?.replaceAll('&amp;', '&'), displayName: `u/${me.name}` });
    } catch (error) {
      return checkProblem(error);
    }
  }

  /** The profile's followers, Reddit's subscribers to the user's own page */
  async profileStats(): Promise<ProfileStats> {
    const me = await this.#me();
    return statsOf({ followers: me.subreddit?.subscribers }, { karma: me.total_karma });
  }
}
