import type { GitHubTokenSource } from './github-discussions.ts';
import { HttpClient, type EtagCache } from './http-client.ts';

/** The REST version every GitHub call names, as the engine's own client does: answers keep their shape */
export const GITHUB_API_VERSION = '2022-11-28';

/** One day of GitHub's traffic buckets: views and clones, each with its unique visitors */
export interface TrafficDay {
  /** YYYY-MM-DD, the UTC day GitHub buckets it in */
  day: string;
  views: number;
  uniqueVisitors: number;
  clones: number;
  uniqueCloners: number;
}

/** A referring site or a page of the repo, with its views and unique visitors */
export interface TrafficSource {
  name: string;
  count: number;
  uniques: number;
}

/**
 * A repo's traffic as GitHub's Insights show it: totals of the last 14 days, the same days one by
 * one, and the top ten referring sites and pages of those days.
 */
export interface RepoTraffic {
  views: number;
  uniqueVisitors: number;
  clones: number;
  uniqueCloners: number;
  days: TrafficDay[];
  referrers: TrafficSource[];
  paths: TrafficSource[];
}

/** What only a repo's history tells: the stars given each day, and each release's downloads */
export interface RepoHistory {
  /** Stars given on each day, YYYY-MM-DD, from the newest 30 weeks; days with none left out */
  starsByDay: Record<string, number>;
  /** Downloads of each release's assets, by its tag */
  downloadsByTag: Record<string, number>;
}

interface Bucket {
  timestamp: string;
  count: number;
  uniques: number;
}

/**
 * A launched repo's numbers as the hourly reads take them, split by how often each changes
 * (docs/plans/performance-refactor.md, "5. Metrics"): the counts hourly through a conditional GET,
 * whose 304 costs nothing of GitHub's rate limit when no one starred, and the traffic and the
 * history daily, since GitHub buckets them by day.
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
    return { authorization: `Bearer ${await this.#auth.token()}`, accept: 'application/vnd.github+json', 'x-github-api-version': GITHUB_API_VERSION, 'user-agent': 'shipcast' };
  }

  async #json<T>(path: string, what: string): Promise<T> {
    return this.#http.json<T>(path, { headers: await this.#headers(), what });
  }

  /** Stars, forks and watchers; a 304 answers from the cache with what was read last */
  async counts(repo: string): Promise<{ stars: number; forks: number; watchers: number }> {
    const info = await this.#json<{ stargazers_count: number; forks_count: number; subscribers_count: number }>(`/repos/${repo}`, `read ${repo}`);
    return { stars: info.stargazers_count, forks: info.forks_count, watchers: info.subscribers_count };
  }

  /**
   * Views, clones, referring sites and pages of the last 14 days, which need the App's
   * Administration: read. A refusal throws a ConnectorError with GitHub's status (403 without the
   * permission), never an empty answer: the caller says so instead of reading nothing in silence.
   */
  async traffic(repo: string): Promise<RepoTraffic> {
    const views = await this.#json<{ count: number; uniques: number; views?: Bucket[] }>(`/repos/${repo}/traffic/views?per=day`, `read ${repo}'s traffic`);
    const clones = await this.#json<{ count: number; uniques: number; clones?: Bucket[] }>(`/repos/${repo}/traffic/clones?per=day`, `read ${repo}'s clones`);
    const referrers = await this.#json<Array<{ referrer: string; count: number; uniques: number }>>(`/repos/${repo}/traffic/popular/referrers`, `read ${repo}'s referrers`);
    const paths = await this.#json<Array<{ path: string; count: number; uniques: number }>>(`/repos/${repo}/traffic/popular/paths`, `read ${repo}'s popular pages`);
    const days = new Map<string, TrafficDay>();
    const dayOf = (timestamp: string) => {
      const day = timestamp.slice(0, 10);
      let entry = days.get(day);
      if (!entry) days.set(day, (entry = { day, views: 0, uniqueVisitors: 0, clones: 0, uniqueCloners: 0 }));
      return entry;
    };
    for (const b of views.views ?? []) Object.assign(dayOf(b.timestamp), { views: b.count, uniqueVisitors: b.uniques });
    for (const b of clones.clones ?? []) Object.assign(dayOf(b.timestamp), { clones: b.count, uniqueCloners: b.uniques });
    return {
      views: views.count,
      uniqueVisitors: views.uniques,
      clones: clones.count,
      uniqueCloners: clones.uniques,
      days: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
      referrers: referrers.map((r) => ({ name: r.referrer, count: r.count, uniques: r.uniques })),
      paths: paths.map((p) => ({ name: p.path, count: p.count, uniques: p.uniques })),
    };
  }

  /**
   * The stars given each day (`/stargazers/history`, weeks of seven days from Sunday, the newest
   * first) and the downloads of each release's assets: what the counts cannot say, the day a star
   * came and how often a release was fetched. Both need only Metadata and Contents: read.
   */
  async history(repo: string): Promise<RepoHistory> {
    const weeks = await this.#json<Array<{ week: number; days: number[] }>>(`/repos/${repo}/stargazers/history?per_page=30`, `read ${repo}'s stars by week`);
    const starsByDay: Record<string, number> = {};
    for (const { week, days } of weeks) {
      days.forEach((stars, i) => {
        if (stars > 0) starsByDay[new Date((week + i * 86_400) * 1000).toISOString().slice(0, 10)] = stars;
      });
    }
    // Every release, a hundred a page, newest first: a repo past a hundred releases would otherwise
    // drop its oldest from `downloads_total`, which then reads as downloads lost. Ten pages at most
    const downloadsByTag: Record<string, number> = {};
    for (let page = 1; page <= 10; page++) {
      const releases = await this.#json<Array<{ tag_name: string; assets?: Array<{ download_count: number }> }>>(`/repos/${repo}/releases?per_page=100&page=${page}`, `read ${repo}'s releases`);
      for (const r of releases) downloadsByTag[r.tag_name] = (r.assets ?? []).reduce((n, a) => n + a.download_count, 0);
      if (releases.length < 100) break;
    }
    return { starsByDay, downloadsByTag };
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
