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

/** A pull request that carries a set of files, opened from a fresh branch off the base. */
export interface PullRequestDraft {
  repo: string;
  branch: string;
  base: string;
  title: string;
  body: string;
  message: string;
  files: Array<{ path: string; content: string }>;
}

/** The writes the engine makes on GitHub; a fake stands in for it in tests. */
export interface GitHubWriter {
  /** Opens the pull request, or returns the open one for the same branch */
  openPullRequest(draft: PullRequestDraft): Promise<{ number: number; url: string; created: boolean }>;
}

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
export class GitHubRest implements GitHubSource, GitHubWriter {
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #base: string;

  constructor(options: { token: string; fetch?: typeof fetch; baseUrl?: string }) {
    this.#token = options.token;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#base = options.baseUrl ?? 'https://api.github.com';
  }

  #headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${this.#token}`,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'shipcast',
      ...extra,
    };
  }

  async userEvents(owner: string, etag?: string): Promise<EventsPage> {
    const response = await this.#fetch(`${this.#base}/users/${encodeURIComponent(owner)}/events/public?per_page=100`, {
      headers: this.#headers(etag ? { 'if-none-match': etag } : {}),
    });
    if (response.status === 304) return { notModified: true };
    if (!response.ok) throw new GitHubError(`GitHub events for ${owner}: ${response.status}`, response.status);
    const raw = (await response.json()) as RawEvent[];
    return { notModified: false, etag: response.headers.get('etag') ?? undefined, events: raw.flatMap(toEvent) };
  }

  async fileAt(repo: string, path: string, ref: string): Promise<string | undefined> {
    const url = `${this.#base}/repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`;
    const response = await this.#fetch(url, { headers: this.#headers({ accept: 'application/vnd.github.raw+json' }) });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new GitHubError(`GitHub ${repo}/${path}@${ref}: ${response.status}`, response.status);
    return response.text();
  }

  async #json(method: string, path: string, body?: unknown): Promise<{ status: number; data: unknown }> {
    const response = await this.#fetch(`${this.#base}${path}`, {
      method,
      headers: this.#headers(body === undefined ? {} : { 'content-type': 'application/json' }),
      body: body === undefined ? undefined : JSON.stringify(body),
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
    const baseCommit = (await this.#ok('GET', `/repos/${draft.repo}/git/commits/${base.object.sha}`)) as { tree: { sha: string } };
    const tree = (await this.#ok('POST', `/repos/${draft.repo}/git/trees`, {
      base_tree: baseCommit.tree.sha,
      tree: draft.files.map((f) => ({ path: f.path, mode: '100644', type: 'blob', content: f.content })),
    })) as { sha: string };
    const commit = (await this.#ok('POST', `/repos/${draft.repo}/git/commits`, {
      message: draft.message,
      tree: tree.sha,
      parents: [base.object.sha],
    })) as { sha: string };

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
