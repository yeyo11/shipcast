import { GITHUB_API_VERSION } from './github-repo.ts';
import { checkProblem, json, okCheck, statsOf, type Check, type Profile, type ProfileReader, type ProfileStats } from './http.ts';

interface GitHubUserAnswer {
  login: string;
  name: string | null;
  bio: string | null;
  blog: string | null;
  twitter_username: string | null;
  avatar_url: string | null;
  followers: number;
  following: number;
  public_repos: number;
}

/**
 * The owner's GitHub profile through GitHub's public API (`GET /users/{login}`): what everyone can
 * see, so no credential at all. Read for the profile review and the daily snapshot; editing it needs
 * the App's user permission "Profile: write", which Shipcast does not ask for.
 */
export class GitHubProfile implements ProfileReader {
  readonly #login: string;
  readonly #fetch: typeof fetch;
  readonly #base: string;

  constructor(options: { login: string; fetch?: typeof fetch; baseUrl?: string }) {
    this.#login = options.login.trim().replace(/^@/, '');
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#base = options.baseUrl ?? 'https://api.github.com';
  }

  async #user(): Promise<GitHubUserAnswer> {
    const response = await this.#fetch(`${this.#base}/users/${encodeURIComponent(this.#login)}`, {
      headers: { accept: 'application/vnd.github+json', 'x-github-api-version': GITHUB_API_VERSION, 'user-agent': 'shipcast' },
    });
    return json<GitHubUserAnswer>('GitHub', response, `read @${this.#login}`);
  }

  async check(): Promise<Check> {
    try {
      const user = await this.#user();
      return okCheck(`@${user.login}`, { avatarUrl: user.avatar_url, displayName: user.name });
    } catch (error) {
      return checkProblem(error);
    }
  }

  /** Followers and following; the public repos are GitHub's own count */
  async profileStats(): Promise<ProfileStats> {
    const user = await this.#user();
    return statsOf({ followers: user.followers, following: user.following }, { repos: user.public_repos });
  }

  /** Name, bio, website and X account: what the profile shows beside the picture */
  async profile(): Promise<Profile> {
    const user = await this.#user();
    const links = [
      ...(user.blog?.trim() ? [{ name: 'Website', value: user.blog.trim() }] : []),
      ...(user.twitter_username ? [{ name: 'X', value: `https://x.com/${user.twitter_username}` }] : []),
    ];
    return {
      ...(user.name?.trim() && { displayName: user.name.trim() }),
      ...(user.bio?.trim() && { bio: user.bio.trim() }),
      links,
      hasAvatar: Boolean(user.avatar_url),
      editable: { ok: false, why: 'editing a GitHub profile needs the App’s user permission “Profile: write”, which Shipcast does not ask for' },
    };
  }
}
