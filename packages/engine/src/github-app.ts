import { createPrivateKey, createSign, type KeyObject } from 'node:crypto';
import { GitHubError } from './github.ts';

/**
 * Something that hands out a GitHub token when a request needs one. A personal token is a constant;
 * an App's installation token expires within the hour and is minted again when it is close to.
 */
export interface GitHubAuth {
  token(): Promise<string>;
  /** Forgets a token GitHub refused, so the next request mints a fresh one */
  invalidate?(): void;
}

/** The installation of the App on one account, as GitHub describes it */
export interface Installation {
  id: number;
  account: string;
  /** `all` when the owner installed it on every repo, new ones included */
  repositorySelection: 'all' | 'selected';
  permissions: Record<string, string>;
}

export interface GitHubAppOptions {
  /** The App's numeric id; the JWT's issuer when there is no client id */
  appId: string;
  /** GitHub's recommended issuer for the JWT since 2024 */
  clientId?: string;
  /** The App's private key, PEM */
  privateKey: string;
  /**
   * Where the engine's installation is: the launches repo (`owner/name`, which also covers an
   * organisation), or a user's login while no launches repo is set
   */
  account: () => string | undefined;
  fetch?: typeof fetch;
  baseUrl?: string;
  now?: () => number;
}

const b64url = (value: string | Buffer) => Buffer.from(value).toString('base64url');

/**
 * The JWT that authenticates as the App itself (RS256, at most ten minutes). Its start is set a
 * minute back because GitHub refuses a token issued "in the future" by a clock a little ahead.
 */
export function appJwt(issuer: string, key: KeyObject | string, nowMs = Date.now()): string {
  const now = Math.floor(nowMs / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: issuer }));
  const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(key);
  return `${header}.${payload}.${b64url(signature)}`;
}

/** A token is minted again this long before GitHub says it expires, so no request carries one that dies on the way */
const MARGIN_MS = 5 * 60_000;

/**
 * The engine's GitHub access as the App: installation access tokens minted on demand from the
 * private key and kept until shortly before they expire (an hour). The installation is looked up
 * for the account that owns the launches repo and remembered until a webhook says it changed.
 */
export class GitHubApp implements GitHubAuth {
  readonly #options: GitHubAppOptions;
  readonly #key: KeyObject;
  readonly #fetch: typeof fetch;
  readonly #base: string;
  readonly #now: () => number;
  #installation: Promise<Installation> | undefined;
  #installationFor: string | undefined;
  #token: { value: string; expires: number } | undefined;
  #minting: Promise<string> | undefined;

  constructor(options: GitHubAppOptions) {
    this.#options = options;
    // Parsed once: a malformed key fails at start, not at the first background request
    this.#key = createPrivateKey(options.privateKey);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#base = options.baseUrl ?? 'https://api.github.com';
    this.#now = options.now ?? Date.now;
  }

  jwt(): string {
    return appJwt(this.#options.clientId ?? this.#options.appId, this.#key, this.#now());
  }

  async #app(method: string, path: string): Promise<{ status: number; data: unknown }> {
    const response = await this.#fetch(`${this.#base}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${this.jwt()}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'shipcast',
      },
    });
    return { status: response.status, data: await response.json().catch(() => null) };
  }

  /** The App's own description: its slug and the bot that commits as it */
  async describe(): Promise<{ slug: string; name: string }> {
    const { status, data } = await this.#app('GET', '/app');
    if (status !== 200) throw new GitHubError(`GitHub refused the App's key (${status}): check SHIPCAST_GITHUB_APP_ID and the private key`, status);
    const app = data as { slug: string; name: string };
    return { slug: app.slug, name: app.name };
  }

  /** The installation on the launches repo's owner, looked up once and kept until `refresh` */
  installation(): Promise<Installation> {
    const account = this.#options.account();
    if (!account) return Promise.reject(new GitHubError('no account to find the GitHub App installation on: set the launches repo in Settings', 0));
    if (this.#installationFor !== account.toLowerCase()) this.refresh();
    this.#installationFor = account.toLowerCase();
    this.#installation ??= this.#lookUp(account).catch((error: unknown) => {
      this.#installation = undefined;
      throw error;
    });
    return this.#installation;
  }

  async #lookUp(account: string): Promise<Installation> {
    const path = account.includes('/') ? `/repos/${account}/installation` : `/users/${encodeURIComponent(account)}/installation`;
    const { status, data } = await this.#app('GET', path);
    if (status === 404) throw new GitHubError(`the GitHub App is not installed on ${account}: install it from the App's page on GitHub`, 404);
    if (status !== 200) throw new GitHubError(`GitHub could not find the App's installation on ${account}: ${status}`, status);
    const raw = data as { id: number; account: { login: string }; repository_selection: 'all' | 'selected'; permissions: Record<string, string> };
    return { id: raw.id, account: raw.account.login, repositorySelection: raw.repository_selection, permissions: raw.permissions };
  }

  /** Forgets the installation and its token, after GitHub said it was added, changed or removed */
  refresh(): void {
    this.#installation = undefined;
    this.#token = undefined;
  }

  invalidate(): void {
    this.#token = undefined;
  }

  async token(): Promise<string> {
    if (this.#token && this.#token.expires - MARGIN_MS > this.#now()) return this.#token.value;
    // Requests that arrive together while a token is being minted share it instead of minting several
    this.#minting ??= this.#mint().finally(() => {
      this.#minting = undefined;
    });
    return this.#minting;
  }

  async #mint(): Promise<string> {
    const installation = await this.installation();
    const { status, data } = await this.#app('POST', `/app/installations/${installation.id}/access_tokens`);
    if (status === 404) {
      // Uninstalled since it was looked up: look again next time
      this.refresh();
      throw new GitHubError(`the GitHub App's installation on ${installation.account} is gone: install it again`, 404);
    }
    if (status !== 201) throw new GitHubError(`GitHub did not issue an installation token: ${status}`, status);
    const minted = data as { token: string; expires_at: string };
    this.#token = { value: minted.token, expires: Date.parse(minted.expires_at) };
    return minted.token;
  }
}
