import { createHash } from 'node:crypto';
import type { EtagCache } from '@shipcast/connectors';
import type { GitHubAuth } from './github-app.ts';

/** An event of a user's public timeline, reduced to what triggers a launch. */
export type GitHubEvent =
  | {
      id: string;
      type: 'release';
      repo: string;
      tag: string;
      prerelease: boolean;
      url: string;
      at: string;
    }
  | { id: string; type: 'public'; repo: string; at: string };

export type EventsPage = { notModified: true } | { notModified: false; etag: string | undefined; events: GitHubEvent[] };

/** The reads the engine needs from GitHub; a fake stands in for it in tests. */
export interface GitHubSource {
  /** The user's public events, newest first; `etag` makes the request conditional. */
  userEvents(owner: string, etag?: string): Promise<EventsPage>;
  /** A file's text at a ref, or undefined when it does not exist there. */
  fileAt(repo: string, path: string, ref: string): Promise<string | undefined>;
  /** The repo's latest published release (not a draft or pre-release), for manual launches */
  latestRelease(repo: string): Promise<{ tag: string; url: string } | undefined>;
  /** Whether a pull request is still open, was merged, or was closed without merging */
  pullRequestState(repo: string, number: number): Promise<'open' | 'merged' | 'closed'>;
}

/**
 * Where a repo's code at a ref can be downloaded without a GitHub token: what an AI provider that
 * fetches the repository itself (Claudio's workspaces) is given, so no token of GitHub's ever leaves
 * Shipcast. A fake stands in for it in tests.
 */
export interface RepoArchiveSource {
  /** A short-lived download URL of the gzip tarball (GitHub's codeload) */
  tarballUrl(repo: string, ref: string): Promise<string>;
}

/** A repo's public numbers, and its traffic when the token may read it. */
export interface RepoStats {
  stars: number;
  forks: number;
  watchers: number;
  /** Views and unique visitors of the last 14 days (GitHub keeps no more); absent without access */
  views?: number;
  uniqueVisitors?: number;
}

interface RawEvent {
  id: string;
  type: string;
  created_at: string;
  repo: { name: string };
  payload: {
    action?: string;
    release?: { tag_name: string; prerelease: boolean; draft: boolean; html_url: string };
  };
}

/** A file of a commit's tree: its path, its blob sha and its size in bytes */
export interface TreeFile {
  path: string;
  sha: string;
  size: number;
}

/** A pull request that carries a set of files, opened from a fresh branch off the base. */
export interface PullRequestDraft {
  repo: string;
  branch: string;
  base: string;
  title: string;
  body: string;
  message: string;
  /** Text files go inline; binary ones (images, video) are uploaded as blobs first */
  files: Array<{ path: string; content: string } | { path: string; bytes: Uint8Array }>;
}

/** A file in a commit made straight onto a branch: written, or removed */
export type CommitFile = PullRequestDraft['files'][number] | { path: string; delete: true };

/**
 * A launch's preview on the real site (docs/app-review.md): a branch of the launches repo with the
 * site's files, and a draft pull request from it, which is what the repo's workflow deploys to a
 * `*.workers.dev` preview. A draft cannot be merged by mistake.
 */
export interface PreviewWriter {
  /** The branch made again from the base with the files as one commit (forced: a preview has nothing to keep), and its draft pull request, opened unless open */
  pushPreview(draft: Omit<PullRequestDraft, 'files'> & { files: CommitFile[] }): Promise<{ number: number; url: string; sha: string }>;
  /** The bodies of the comments on a pull request, oldest first */
  pullRequestComments(repo: string, number: number): Promise<string[]>;
  /** Closes the preview's pull request and deletes its branch; either already gone is not an error */
  closePreview(repo: string, number: number, branch: string): Promise<void>;
}

/** The writes the engine makes on GitHub; a fake stands in for it in tests. */
export interface GitHubWriter {
  /** Opens the pull request, or returns the open one for the same branch */
  openPullRequest(draft: PullRequestDraft): Promise<{ number: number; url: string; created: boolean }>;
  /** Commits straight onto a branch, for what is published without a pull request */
  commitToBranch?(repo: string, branch: string, message: string, files: PullRequestDraft['files']): Promise<{ sha: string }>;
}

/**
 * Files read from GitHub that change only by a push Shipcast hears of (a `push` webhook, its own
 * commits and merges, the hourly poll): `brand.yml`, `projects.yml`, a launch's `launch.yml` and
 * `pack.json`. `keeps` is the policy, so the client never caches a draft on a branch the owner edits.
 * An absent file is never kept: one that appears (a merge's pack.json) must be seen at once.
 */
export interface FileCache {
  keeps(repo: string, path: string, ref: string): boolean;
  get(repo: string, path: string, ref: string): Promise<string | undefined>;
  set(repo: string, path: string, ref: string, text: string): Promise<void>;
  /** Forgets these paths of the repo, or every file of it when none are named */
  forget(repo: string, paths?: readonly string[]): Promise<void>;
}

/** Bodies past this are not kept for a 304: GitHub's answers Shipcast reads are a few KB */
const MAX_CACHED_BODY = 1024 * 1024;

const sha = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16);

export class GitHubError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/**
 * GitHub's REST API over `fetch`, for the two reads detection makes. Conditional requests matter
 * here: polling the events every few minutes costs nothing while nothing happens, because a `304`
 * does not count against the rate limit.
 */
export class GitHubRest implements GitHubSource, GitHubWriter, RepoArchiveSource, PreviewWriter {
  readonly #auth: GitHubAuth;
  readonly #fetch: typeof fetch;
  readonly #base: string;
  readonly #etags: EtagCache | undefined;
  readonly #files: FileCache | undefined;

  /**
   * A personal token, or something that mints one per request (the GitHub App's installation).
   * With `etags` every GET is conditional (phase 7 of docs/plans/performance-refactor.md): a 304
   * costs no rate limit and is answered from the cache; with `files`, the files of the FileCache
   * policy are not read again until a push says they changed.
   */
  constructor(options: { token: string | GitHubAuth; fetch?: typeof fetch; baseUrl?: string; etags?: EtagCache; files?: FileCache }) {
    const token = options.token;
    // A personal token is its own scope: two tokens never share a cached answer
    this.#auth = typeof token === 'string' ? { token: async () => token, scope: async () => `token:${sha(token)}` } : token;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#base = options.baseUrl ?? 'https://api.github.com';
    this.#etags = options.etags;
    this.#files = options.files;
  }

  /** The file cache this client keeps, for the webhook's and the poll's invalidation */
  get files(): FileCache | undefined {
    return this.#files;
  }

  /** What hands out the token: the GitHub Discussions connector asks it for one per GraphQL query */
  get auth(): GitHubAuth {
    return this.#auth;
  }

  /**
   * One request to the API with the current token. A 401 means the token was revoked or expired
   * early (an App's installation can be suspended); a minted token is then forgotten and the request
   * tried once more with a fresh one.
   */
  async #request(url: string, init: { method?: string; headers?: Record<string, string>; body?: string; redirect?: RequestInit['redirect'] } = {}): Promise<Response> {
    const key = await this.#etagKey(url, init);
    const cached = key === undefined ? undefined : await this.#etags?.get(key);
    const send = async () =>
      this.#fetch(url, {
        ...init,
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${await this.#auth.token()}`,
          'x-github-api-version': '2022-11-28',
          'user-agent': 'shipcast',
          ...(cached && { 'if-none-match': cached.etag }),
          ...init.headers,
        },
      });
    let response = await send();
    if (response.status === 401 && this.#auth.invalidate) {
      this.#auth.invalidate();
      response = await send();
    }
    if (key === undefined || !this.#etags) return response;
    // The 304 is what telemetry counts; the caller gets the body it proved is still current
    if (response.status === 304 && cached) {
      response.body?.cancel().catch(() => undefined);
      return new Response(cached.body, { status: cached.status, headers: cached.headers });
    }
    const etag = response.headers.get('etag');
    if (response.status === 200 && etag) {
      const body = await response.clone().text();
      if (body.length <= MAX_CACHED_BODY) {
        // The body is stored decoded: the encoding and length GitHub sent no longer describe it
        const headers = Object.fromEntries([...response.headers].filter(([name]) => name !== 'content-encoding' && name !== 'content-length'));
        await this.#etags.set(key, { etag, body, status: 200, headers });
      }
    }
    return response;
  }

  /**
   * The cache key of a GET: who reads (the installation or the token, never the hourly token
   * itself, which would empty the cache every hour), what representation (raw or JSON) and the URL.
   * None for a write, without a cache, or when the caller sends its own validator (the events poll).
   */
  async #etagKey(url: string, init: { method?: string; headers?: Record<string, string>; redirect?: RequestInit['redirect'] }): Promise<string | undefined> {
    if (!this.#etags || init.redirect === 'manual' || (init.method ?? 'GET').toUpperCase() !== 'GET' || init.headers?.['if-none-match'] !== undefined) return undefined;
    let scope: string;
    try {
      scope = this.#auth.scope ? await this.#auth.scope() : `token:${sha(await this.#auth.token())}`;
    } catch {
      // The request itself fails the same way, with its own message
      return undefined;
    }
    return `github ${scope} ${init.headers?.accept ?? 'json'} ${url}`;
  }

  async userEvents(owner: string, etag?: string): Promise<EventsPage> {
    const response = await this.#request(`${this.#base}/users/${encodeURIComponent(owner)}/events/public?per_page=100`, {
      headers: etag ? { 'if-none-match': etag } : {},
    });
    if (response.status === 304) return { notModified: true };
    if (!response.ok) throw new GitHubError(`GitHub events for ${owner}: ${response.status}`, response.status);
    const raw = (await response.json()) as RawEvent[];
    return { notModified: false, etag: response.headers.get('etag') ?? undefined, events: raw.flatMap(toEvent) };
  }

  async fileAt(repo: string, path: string, ref: string): Promise<string | undefined> {
    const files = this.#files?.keeps(repo, path, ref) ? this.#files : undefined;
    const kept = await files?.get(repo, path, ref);
    if (kept !== undefined) return kept;
    // HEAD means the default branch, which is what the API reads when no ref is given
    const query = ref === 'HEAD' ? '' : `?ref=${encodeURIComponent(ref)}`;
    const url = `${this.#base}/repos/${repo}/contents/${path}${query}`;
    const response = await this.#request(url, { headers: { accept: 'application/vnd.github.raw+json' } });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new GitHubError(`GitHub ${repo}/${path}@${ref}: ${response.status}`, response.status);
    const text = await response.text();
    await files?.set(repo, path, ref, text);
    return text;
  }

  /**
   * The tarball's download URL: GitHub answers the API's tarball request, made with the token, with a
   * redirect to codeload, whose URL carries a download grant of its own (for a private repo, a
   * short-lived one in its query). The redirect is read, never followed, so the archive is not
   * downloaded here and the token is only ever sent to GitHub's API.
   */
  async tarballUrl(repo: string, ref: string): Promise<string> {
    // HEAD means the default branch, which is what the API reads when no ref is given
    const path = `/repos/${repo}/tarball${ref === 'HEAD' ? '' : `/${encodeURIComponent(ref)}`}`;
    const response = await this.#request(`${this.#base}${path}`, { redirect: 'manual' });
    response.body?.cancel().catch(() => undefined);
    const location = response.headers.get('location');
    if (response.status < 300 || response.status >= 400 || !location) throw new GitHubError(`GitHub tarball of ${repo}@${ref}: ${response.status}`, response.status);
    const url = new URL(location, this.#base);
    if (url.protocol !== 'https:') throw new GitHubError(`GitHub tarball of ${repo}@${ref}: not an https download (${url.protocol})`, response.status);
    return url.href;
  }

  async latestRelease(repo: string): Promise<{ tag: string; url: string } | undefined> {
    const { status, data } = await this.#json('GET', `/repos/${repo}/releases/latest`);
    if (status === 404) return undefined;
    if (status >= 300) throw new GitHubError(`GitHub latest release of ${repo}: ${status}`, status);
    const release = data as { tag_name: string; html_url: string };
    return { tag: release.tag_name, url: release.html_url };
  }

  /**
   * Traffic needs Administration: read on the repo, which neither the GitHub App nor its user
   * tokens are granted: it comes back with a fine-grained personal token (a connected GitHub
   * account). Without it the public numbers still do.
   */
  async repoStats(repo: string): Promise<RepoStats> {
    const info = (await this.#ok('GET', `/repos/${repo}`)) as { stargazers_count: number; forks_count: number; subscribers_count: number };
    const stats: RepoStats = { stars: info.stargazers_count, forks: info.forks_count, watchers: info.subscribers_count };
    const traffic = await this.#json('GET', `/repos/${repo}/traffic/views`);
    if (traffic.status === 200) {
      const views = traffic.data as { count: number; uniques: number };
      stats.views = views.count;
      stats.uniqueVisitors = views.uniques;
    }
    return stats;
  }

  async pullRequestState(repo: string, number: number): Promise<'open' | 'merged' | 'closed'> {
    const pr = (await this.#ok('GET', `/repos/${repo}/pulls/${number}`)) as { state: 'open' | 'closed'; merged: boolean };
    return pr.state === 'open' ? 'open' : pr.merged ? 'merged' : 'closed';
  }

  async #json(method: string, path: string, body?: unknown): Promise<{ status: number; data: unknown }> {
    const response = await this.#request(`${this.#base}${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const data = response.status === 204 ? null : await response.json().catch(() => null);
    return { status: response.status, data };
  }

  async #ok(method: string, path: string, body?: unknown): Promise<unknown> {
    const { status, data } = await this.#json(method, path, body);
    if (status >= 300) throw new GitHubError(`GitHub ${method} ${path}: ${status} ${JSON.stringify(data).slice(0, 200)}`, status);
    return data;
  }

  /**
   * One commit with every file, on a branch made from the base, then the pull request. Through the
   * Git data API (tree, commit, ref) so the files land in a single commit without a local clone.
   * Re-running for a branch whose pull request is open returns it instead of opening a second one.
   */
  async openPullRequest(draft: PullRequestDraft): Promise<{ number: number; url: string; created: boolean }> {
    const [owner] = draft.repo.split('/');
    const open = (await this.#ok('GET', `/repos/${draft.repo}/pulls?state=open&head=${owner}:${encodeURIComponent(draft.branch)}`)) as Array<{
      number: number;
      html_url: string;
    }>;
    if (open[0]) return { number: open[0].number, url: open[0].html_url, created: false };

    const base = (await this.#ok('GET', `/repos/${draft.repo}/git/ref/heads/${encodeURIComponent(draft.base)}`)) as { object: { sha: string } };
    const commit = await this.#commit(draft.repo, base.object.sha, draft.message, draft.files);

    // A branch left over from a run whose pull request was closed is moved, not duplicated
    const created = await this.#json('POST', `/repos/${draft.repo}/git/refs`, { ref: `refs/heads/${draft.branch}`, sha: commit.sha });
    if (created.status === 422) {
      await this.#ok('PATCH', `/repos/${draft.repo}/git/refs/heads/${encodeURIComponent(draft.branch)}`, { sha: commit.sha, force: true });
    } else if (created.status >= 300) {
      throw new GitHubError(`GitHub could not create ${draft.branch}: ${created.status}`, created.status);
    }

    const pr = (await this.#ok('POST', `/repos/${draft.repo}/pulls`, {
      title: draft.title,
      head: draft.branch,
      base: draft.base,
      body: draft.body,
    })) as { number: number; html_url: string };
    return { number: pr.number, url: pr.html_url, created: true };
  }

  /** A release by tag; the draft flag lets the caller tell an unpublished one apart. */
  /** A commit with every file on top of a parent, through the Git data API: no clone, one commit */
  async #commit(repo: string, parent: string, message: string, files: CommitFile[]): Promise<{ sha: string }> {
    const parentCommit = (await this.#ok('GET', `/repos/${repo}/git/commits/${parent}`)) as { tree: { sha: string } };
    const entries = [];
    for (const file of files) {
      if ('delete' in file) {
        // A null sha in a tree built on the base tree is how the Git data API removes a path
        entries.push({ path: file.path, mode: '100644', type: 'blob', sha: null });
      } else if ('content' in file) {
        entries.push({ path: file.path, mode: '100644', type: 'blob', content: file.content });
      } else {
        const blob = (await this.#ok('POST', `/repos/${repo}/git/blobs`, {
          content: Buffer.from(file.bytes).toString('base64'),
          encoding: 'base64',
        })) as { sha: string };
        entries.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.sha });
      }
    }
    const tree = (await this.#ok('POST', `/repos/${repo}/git/trees`, { base_tree: parentCommit.tree.sha, tree: entries })) as { sha: string };
    return (await this.#ok('POST', `/repos/${repo}/git/commits`, { message, tree: tree.sha, parents: [parent] })) as { sha: string };
  }

  /**
   * Commits files straight onto a branch, for what is published without a pull request. The ref is
   * moved without force, so a branch that moved meanwhile refuses the commit instead of losing work.
   */
  async commitToBranch(repo: string, branch: string, message: string, files: CommitFile[]): Promise<{ sha: string }> {
    const head = (await this.#ok('GET', `/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`)) as { object: { sha: string } };
    const commit = await this.#commit(repo, head.object.sha, message, files);
    await this.#ok('PATCH', `/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, { sha: commit.sha, force: false });
    // Shipcast's own commit is a push it may never hear of: what it kept of those paths goes now
    await this.#files?.forget(repo, files.map((f) => f.path));
    return commit;
  }

  async pushPreview(draft: Omit<PullRequestDraft, 'files'> & { files: CommitFile[] }): Promise<{ number: number; url: string; sha: string }> {
    const base = (await this.#ok('GET', `/repos/${draft.repo}/git/ref/heads/${encodeURIComponent(draft.base)}`)) as { object: { sha: string } };
    const commit = await this.#commit(draft.repo, base.object.sha, draft.message, draft.files);
    const created = await this.#json('POST', `/repos/${draft.repo}/git/refs`, { ref: `refs/heads/${draft.branch}`, sha: commit.sha });
    if (created.status === 422) {
      await this.#ok('PATCH', `/repos/${draft.repo}/git/refs/heads/${encodeURIComponent(draft.branch)}`, { sha: commit.sha, force: true });
    } else if (created.status >= 300) {
      throw new GitHubError(`GitHub could not create ${draft.branch}: ${created.status}`, created.status);
    }
    const [owner] = draft.repo.split('/');
    const open = (await this.#ok('GET', `/repos/${draft.repo}/pulls?state=open&head=${owner}:${encodeURIComponent(draft.branch)}`)) as Array<{ number: number; html_url: string }>;
    if (open[0]) return { number: open[0].number, url: open[0].html_url, sha: commit.sha };
    const pr = (await this.#ok('POST', `/repos/${draft.repo}/pulls`, { title: draft.title, head: draft.branch, base: draft.base, body: draft.body, draft: true })) as { number: number; html_url: string };
    return { number: pr.number, url: pr.html_url, sha: commit.sha };
  }

  async pullRequestComments(repo: string, number: number): Promise<string[]> {
    const comments = (await this.#ok('GET', `/repos/${repo}/issues/${number}/comments?per_page=100`)) as Array<{ body?: string | null }>;
    return comments.map((c) => c.body ?? '');
  }

  async closePreview(repo: string, number: number, branch: string): Promise<void> {
    const closed = await this.#json('PATCH', `/repos/${repo}/pulls/${number}`, { state: 'closed' });
    if (closed.status >= 300 && closed.status !== 404) throw new GitHubError(`GitHub could not close #${number}: ${closed.status}`, closed.status);
    const deleted = await this.#json('DELETE', `/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`);
    if (deleted.status >= 300 && deleted.status !== 404 && deleted.status !== 422) throw new GitHubError(`GitHub could not delete ${branch}: ${deleted.status}`, deleted.status);
  }

  /** Every file under a folder at a ref, by path; none when the folder is not there */
  async filesUnder(repo: string, ref: string, folder: string): Promise<string[]> {
    const { status, data } = await this.#json('GET', `/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
    if (status === 404) return [];
    if (status >= 300) throw new GitHubError(`GitHub could not list ${repo} at ${ref}: ${status}`, status);
    const prefix = `${folder.replace(/\/+$/, '')}/`;
    return ((data as { tree: Array<{ path: string; type: string }> }).tree ?? []).filter((e) => e.type === 'blob' && e.path.startsWith(prefix)).map((e) => e.path);
  }

  /** The commit a ref (a branch, a tag, a sha) names, so a reader can stay on it while the ref moves */
  async commitSha(repo: string, ref: string): Promise<string> {
    return ((await this.#ok('GET', `/repos/${repo}/commits/${encodeURIComponent(ref)}`)) as { sha: string }).sha;
  }

  /** Every file of a commit with its blob sha, which is the git hash of its bytes */
  async tree(repo: string, sha: string): Promise<TreeFile[]> {
    const data = (await this.#ok('GET', `/repos/${repo}/git/trees/${encodeURIComponent(sha)}?recursive=1`)) as { truncated?: boolean; tree: Array<{ path: string; type: string; sha: string; size?: number }> };
    // A truncated listing would pass for a commit without the files it left out
    if (data.truncated) throw new GitHubError(`GitHub listed ${repo} at ${sha} only in part`, 500);
    return data.tree.filter((e) => e.type === 'blob').map((e) => ({ path: e.path, sha: e.sha, size: e.size ?? 0 }));
  }

  /** A file's bytes by its blob sha, text or not (`fileAt` reads text only) */
  async blob(repo: string, sha: string): Promise<Uint8Array> {
    const data = (await this.#ok('GET', `/repos/${repo}/git/blobs/${encodeURIComponent(sha)}`)) as { content: string; encoding: string };
    if (data.encoding !== 'base64') throw new GitHubError(`GitHub blob ${sha} of ${repo} came as ${data.encoding}`, 500);
    return new Uint8Array(Buffer.from(data.content, 'base64'));
  }

  /** A pull request's branch and state, for reviewing its drafts */
  async pullRequest(
    repo: string,
    number: number,
  ): Promise<{ number: number; url: string; state: 'open' | 'merged' | 'closed'; branch: string; title: string; headSha: string; mergedBy: string | null; mergedAt: string | null }> {
    const pr = (await this.#ok('GET', `/repos/${repo}/pulls/${number}`)) as {
      number: number;
      html_url: string;
      state: 'open' | 'closed';
      merged: boolean;
      title: string;
      head: { ref: string; sha: string };
      merged_by?: { login?: string } | null;
      merged_at?: string | null;
    };
    return {
      number: pr.number,
      url: pr.html_url,
      state: pr.state === 'open' ? 'open' : pr.merged ? 'merged' : 'closed',
      branch: pr.head.ref,
      title: pr.title,
      headSha: pr.head.sha,
      mergedBy: pr.merged_by?.login ?? null,
      mergedAt: pr.merged_at ?? null,
    };
  }

  /** The paths a pull request adds or changes (up to 300, GitHub's page limit times three) */
  async pullRequestFiles(repo: string, number: number): Promise<string[]> {
    return (await this.pullRequestFileEntries(repo, number)).map((f) => f.path);
  }

  /** The same, with each file's blob sha, which the drafts snapshot keeps */
  async pullRequestFileEntries(repo: string, number: number): Promise<Array<{ path: string; sha: string | null }>> {
    const entries: Array<{ path: string; sha: string | null }> = [];
    for (let page = 1; page <= 3; page++) {
      const files = (await this.#ok('GET', `/repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`)) as Array<{ filename: string; status: string; sha?: string | null }>;
      entries.push(...files.filter((f) => f.status !== 'removed').map((f) => ({ path: f.filename, sha: f.sha ?? null })));
      if (files.length < 100) break;
    }
    return entries;
  }

  /** Replaces one text file on a branch, as one commit: an edit made in the app */
  async updateFile(repo: string, branch: string, path: string, content: string, message: string): Promise<void> {
    const current = await this.#json('GET', `/repos/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`);
    const sha = current.status === 200 ? (current.data as { sha: string }).sha : undefined;
    await this.#ok('PUT', `/repos/${repo}/contents/${path}`, {
      message,
      content: Buffer.from(content, 'utf8').toString('base64'),
      branch,
      ...(sha ? { sha } : {}),
    });
    await this.#files?.forget(repo, [path]);
  }

  /** Merges a pull request with a squash, so the launches repo keeps one commit per launch */
  async mergePullRequest(repo: string, number: number, title: string): Promise<{ sha: string }> {
    const merged = (await this.#ok('PUT', `/repos/${repo}/pulls/${number}/merge`, { merge_method: 'squash', commit_title: title })) as { sha: string };
    // A merge lands every file of the pull request on main at once
    await this.#files?.forget(repo);
    return { sha: merged.sha };
  }

  /**
   * The repos the GitHub App's installation can reach, newest push first, with their default branch:
   * where the launches repo is chosen from. Only works with the App's installation token.
   */
  async installationRepos(): Promise<Array<{ repo: string; description: string | null; pushedAt: string; defaultBranch: string; private: boolean }>> {
    const out: Array<{ repo: string; description: string | null; pushedAt: string; defaultBranch: string; private: boolean }> = [];
    for (let page = 1; page <= 5; page++) {
      const data = (await this.#ok('GET', `/installation/repositories?per_page=100&page=${page}`)) as {
        repositories: Array<{ full_name: string; description: string | null; pushed_at: string; default_branch: string; private: boolean; archived: boolean }>;
      };
      out.push(...data.repositories.filter((r) => !r.archived).map((r) => ({ repo: r.full_name, description: r.description, pushedAt: r.pushed_at, defaultBranch: r.default_branch, private: r.private })));
      if (data.repositories.length < 100) break;
    }
    return out.sort((a, b) => b.pushedAt.localeCompare(a.pushedAt));
  }

  /** A repo's default branch, where a file added outside a pull request is committed */
  async defaultBranch(repo: string): Promise<string> {
    return ((await this.#ok('GET', `/repos/${repo}`)) as { default_branch: string }).default_branch;
  }

  /** An owner's public repos, newest push first, for choosing what to launch */
  async userRepos(owner: string): Promise<Array<{ repo: string; description: string | null; pushedAt: string }>> {
    const repos = (await this.#ok('GET', `/users/${encodeURIComponent(owner)}/repos?per_page=100&sort=pushed&type=owner`)) as Array<{
      full_name: string;
      description: string | null;
      pushed_at: string;
      fork: boolean;
      archived: boolean;
    }>;
    return repos.filter((r) => !r.fork && !r.archived).map((r) => ({ repo: r.full_name, description: r.description, pushedAt: r.pushed_at }));
  }

  /** A repo's published releases, newest first */
  async releases(repo: string): Promise<Array<{ tag: string; name: string; publishedAt: string; prerelease: boolean }>> {
    const releases = (await this.#ok('GET', `/repos/${repo}/releases?per_page=30`)) as Array<{
      tag_name: string;
      name: string | null;
      published_at: string | null;
      draft: boolean;
      prerelease: boolean;
    }>;
    return releases
      .filter((r) => !r.draft && r.published_at)
      .map((r) => ({ tag: r.tag_name, name: r.name ?? r.tag_name, publishedAt: r.published_at!, prerelease: r.prerelease }));
  }

  async releaseByTag(repo: string, tag: string): Promise<{ tag: string; url: string; draft: boolean } | undefined> {
    const { status, data } = await this.#json('GET', `/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`);
    if (status === 404) return undefined;
    if (status >= 300) throw new GitHubError(`GitHub release ${tag} of ${repo}: ${status}`, status);
    const release = data as { tag_name: string; html_url: string; draft: boolean };
    return { tag: release.tag_name, url: release.html_url, draft: release.draft };
  }

  /** undefined when the repo has no license; `spdx` is undefined when GitHub does not recognise it. */
  async license(repo: string): Promise<{ spdx: string | undefined } | undefined> {
    const { status, data } = await this.#json('GET', `/repos/${repo}/license`);
    if (status === 404) return undefined;
    if (status >= 300) throw new GitHubError(`GitHub license of ${repo}: ${status}`, status);
    // GitHub reports NOASSERTION for a license file it cannot match to a known one
    const spdx = (data as { license?: { spdx_id?: string | null } | null }).license?.spdx_id;
    return { spdx: spdx && spdx !== 'NOASSERTION' ? spdx : undefined };
  }

  async hasReadme(repo: string, ref: string): Promise<boolean> {
    const query = ref === 'HEAD' ? '' : `?ref=${encodeURIComponent(ref)}`;
    const { status } = await this.#json('GET', `/repos/${repo}/readme${query}`);
    if (status === 404) return false;
    if (status >= 300) throw new GitHubError(`GitHub readme of ${repo}@${ref}: ${status}`, status);
    return true;
  }

  /** Whether a path exists at a ref, without downloading it (a demo GIF can be large). */
  async pathExists(repo: string, path: string, ref: string): Promise<boolean> {
    const query = ref === 'HEAD' ? '' : `?ref=${encodeURIComponent(ref)}`;
    const { status } = await this.#json('GET', `/repos/${repo}/contents/${path}${query}`);
    if (status === 404) return false;
    if (status >= 300) throw new GitHubError(`GitHub ${repo}/${path}@${ref}: ${status}`, status);
    return true;
  }

  /** The status a URL answers to HEAD; no token is sent, since the URL is not GitHub's API. */
  async head(url: string): Promise<number> {
    const response = await this.#fetch(url, { method: 'HEAD', headers: { 'user-agent': 'shipcast' }, redirect: 'follow' });
    return response.status;
  }
}

function toEvent(raw: RawEvent): GitHubEvent[] {
  if (raw.type === 'ReleaseEvent' && raw.payload.action === 'published' && raw.payload.release) {
    const release = raw.payload.release;
    // A draft never reaches the public timeline; checked anyway so one can never become a launch
    if (release.draft) return [];
    return [
      {
        id: raw.id,
        type: 'release',
        repo: raw.repo.name,
        tag: release.tag_name,
        prerelease: release.prerelease,
        url: release.html_url,
        at: raw.created_at,
      },
    ];
  }
  if (raw.type === 'PublicEvent') return [{ id: raw.id, type: 'public', repo: raw.repo.name, at: raw.created_at }];
  return [];
}
