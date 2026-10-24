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
export class GitHubRest implements GitHubSource {
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
