import type { GitHubTokenSource } from './github-discussions.ts';
import { HttpClient, type EtagCache } from './http-client.ts';

/**
 * A launched repo's numbers as the hourly reads take them, split by how often each changes
 * (docs/plans/performance-refactor.md, "5. Metrics"): the counts hourly through a conditional GET,
 * whose 304 costs nothing of GitHub's rate limit when no one starred, and the traffic daily, since
 * GitHub buckets it by day. The engine's GitHub client reads both in one `repoStats`, every run.
 */
export class GitHubRepoStats {
  readonly #auth: GitHubTokenSource;
  readonly #http: HttpClient;

  constructor(options: { auth: GitHubTokenSource; fetch?: typeof fetch; etags?: EtagCache; baseUrl?: string }) {
    this.#auth = options.auth;
    this.#http = new HttpClient({
      network: 'GitHub',
      baseUrl: options.baseUrl ?? 'https://api.github.com',
      ...(options.fetch && { fetch: options.fetch }),
      ...(options.etags && { etags: acrossTokens(options.etags) }),
      timeoutMs: 30_000,
    });
  }

  async #headers(): Promise<Record<string, string>> {
    return { authorization: `Bearer ${await this.#auth.token()}`, accept: 'application/vnd.github+json', 'user-agent': 'shipcast' };
  }

  /** Stars, forks and watchers; a 304 answers from the cache with what was read last */
  async counts(repo: string): Promise<{ stars: number; forks: number; watchers: number }> {
    const info = await this.#http.json<{ stargazers_count: number; forks_count: number; subscribers_count: number }>(`/repos/${repo}`, { headers: await this.#headers(), what: `read ${repo}` });
    return { stars: info.stargazers_count, forks: info.forks_count, watchers: info.subscribers_count };
  }

  /** Views and unique visitors of the last 14 days; undefined without the App's Administration: read */
  async traffic(repo: string): Promise<{ views: number; uniqueVisitors: number } | undefined> {
    const response = await this.#http.request(`/repos/${repo}/traffic/views`, { headers: await this.#headers(), what: `read ${repo}'s traffic` });
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      return undefined;
    }
    const views = (await response.json()) as { count: number; uniques: number };
    return { views: views.count, uniqueVisitors: views.uniques };
  }
}

/**
 * The client keys a validator by the credential it was read with, so one account never gets
 * another's answer. An App installation's token is minted again every hour, which would make every
 * hourly read a miss; the installation is one account whatever its token, so its entries are kept
 * under one scope instead.
 */
function acrossTokens(etags: EtagCache): EtagCache {
  const key = (k: string) => k.replace(/#[0-9a-f]{16}$/, '#installation');
  return { get: (k) => etags.get(key(k)), set: (k, entry) => etags.set(key(k), entry) };
}
