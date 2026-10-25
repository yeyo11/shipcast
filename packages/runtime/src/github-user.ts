import type { SecretStore } from './secrets.ts';

/** The keychain key of the signed-in owner's GitHub user token */
export const GITHUB_USER_KEY = 'app:github-user';

/**
 * A GitHub App's user access token: it acts as the owner, within the App's permissions and the
 * repos it is installed on. It expires after 8 hours; the refresh token after 6 months. An App with
 * expiring tokens turned off gives one without either date.
 */
export interface UserToken {
  login: string;
  accessToken: string;
  /** ISO times; absent when the token does not expire */
  expiresAt?: string;
  refreshToken?: string;
  refreshExpiresAt?: string;
}

export class GitHubSignInError extends Error {}

interface TokenAnswer {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  error?: string;
  error_description?: string;
}

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
}

async function tokenRequest(client: OAuthClient, body: Record<string, string>): Promise<TokenAnswer> {
  const response = await (client.fetch ?? globalThis.fetch)('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: client.clientId, client_secret: client.clientSecret, ...body }),
  });
  const answer = (await response.json().catch(() => ({}))) as TokenAnswer;
  if (!answer.access_token) throw new GitHubSignInError(answer.error_description ?? answer.error ?? `GitHub answered ${response.status}`);
  return answer;
}

function toToken(login: string, answer: TokenAnswer, now: number): UserToken {
  const at = (seconds: number | undefined) => (seconds ? new Date(now + seconds * 1000).toISOString() : undefined);
  const expiresAt = at(answer.expires_in);
  const refreshExpiresAt = at(answer.refresh_token_expires_in);
  return {
    login,
    accessToken: answer.access_token!,
    ...(expiresAt && { expiresAt }),
    ...(answer.refresh_token && { refreshToken: answer.refresh_token }),
    ...(refreshExpiresAt && { refreshExpiresAt }),
  };
}

/** The sign-in's code, swapped for the user's token (and its refresh token, from a GitHub App) */
export async function exchangeCode(client: OAuthClient, code: string, redirectUri: string): Promise<TokenAnswer & { access_token: string }> {
  return (await tokenRequest(client, { code, redirect_uri: redirectUri })) as TokenAnswer & { access_token: string };
}

/** A token is refreshed this long before it expires, so no request goes out with one about to die */
const MARGIN_MS = 5 * 60_000;

/**
 * The owner's GitHub user token, kept in the keychain and refreshed on its own: asking for it within
 * five minutes of its expiry swaps the refresh token for a new pair, saved at once, since GitHub
 * invalidates the old refresh token as it hands out the new one.
 */
export class GitHubUserTokens {
  readonly #secrets: SecretStore;
  readonly #client: OAuthClient;
  readonly #now: () => number;
  #refreshing: Promise<string | undefined> | undefined;

  constructor(options: { secrets: SecretStore; client: OAuthClient; now?: () => number }) {
    this.#secrets = options.secrets;
    this.#client = options.client;
    this.#now = options.now ?? Date.now;
  }

  /** Keeps the token a sign-in gave */
  async save(login: string, answer: TokenAnswer): Promise<UserToken> {
    const token = toToken(login, answer, this.#now());
    await this.#secrets.set(GITHUB_USER_KEY, JSON.stringify(token), `GitHub user token of @${login}`);
    return token;
  }

  async stored(): Promise<UserToken | undefined> {
    const text = await this.#secrets.get(GITHUB_USER_KEY);
    if (!text) return undefined;
    try {
      const token = JSON.parse(text) as UserToken;
      return typeof token.accessToken === 'string' && typeof token.login === 'string' ? token : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * A token that is valid now, refreshed if it needed to be; undefined when there is none, or when
   * the refresh token expired too (the owner signs in again then)
   */
  async token(): Promise<string | undefined> {
    const token = await this.stored();
    if (!token) return undefined;
    if (!token.expiresAt || Date.parse(token.expiresAt) - MARGIN_MS > this.#now()) return token.accessToken;
    // Two callers at once share one refresh: a second one would spend the refresh token already spent
    this.#refreshing ??= this.#refresh(token).finally(() => {
      this.#refreshing = undefined;
    });
    return this.#refreshing;
  }

  async #refresh(token: UserToken): Promise<string | undefined> {
    if (!token.refreshToken || (token.refreshExpiresAt && Date.parse(token.refreshExpiresAt) <= this.#now())) {
      await this.#secrets.delete(GITHUB_USER_KEY);
      return undefined;
    }
    try {
      const answer = await tokenRequest(this.#client, { grant_type: 'refresh_token', refresh_token: token.refreshToken });
      return (await this.save(token.login, answer)).accessToken;
    } catch (error) {
      // A refused refresh token (revoked, or the App's secret changed) will not work later either
      if (error instanceof GitHubSignInError) {
        await this.#secrets.delete(GITHUB_USER_KEY);
        return undefined;
      }
      throw error;
    }
  }

  async forget(): Promise<void> {
    await this.#secrets.delete(GITHUB_USER_KEY);
  }
}
