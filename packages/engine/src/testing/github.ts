import type { BlogRepo } from '../edit.ts';
import { GitHubError, type CommitFile, type EventsPage, type GitHubSource, type GitHubWriter, type PullRequestDraft, type RepoStats } from '../github.ts';
import type { ReviewGitHub } from '../review.ts';

/*
 * One GitHub for every test: repos as a map of files per ref, pull requests that carry files on
 * their branch, commits that write them, and every call recorded. It stands in for `GitHubRest`
 * wherever the engine takes one of its narrower interfaces (GitHubSource, GitHubWriter, BlogRepo,
 * ReviewGitHub, PreflightSource's reads), so tests stop writing their own.
 */

export type PullRequestState = 'open' | 'merged' | 'closed';

export interface FakePullRequest {
  repo: string;
  number: number;
  branch: string;
  base: string;
  title: string;
  body: string;
  state: PullRequestState;
  /** The paths the pull request changes, as GitHub lists them */
  files: string[];
}

/** The methods a fake GitHub can be asked, by name, for the call log and for failures */
export type GitHubMethod =
  | 'userEvents'
  | 'fileAt'
  | 'latestRelease'
  | 'pullRequestState'
  | 'openPullRequest'
  | 'commitToBranch'
  | 'filesUnder'
  | 'pullRequest'
  | 'pullRequestFiles'
  | 'updateFile'
  | 'mergePullRequest'
  | 'repoStats'
  | 'defaultBranch';

export interface GitHubCall {
  method: GitHubMethod;
  args: unknown[];
}

export interface FakeGitHubOptions {
  /** Text files by `owner/name/path@ref`, the key `FakeGitHub.key` builds; `HEAD` is the default branch */
  files?: Record<string, string>;
  /** Pages `userEvents` answers in turn; once they run out it answers not modified */
  events?: EventsPage[];
  latestRelease?: { tag: string; url: string };
  /** What `pullRequestState` answers for a pull request the fake was not given: most tests only need open or merged */
  pullRequestState?: PullRequestState;
  /** The name `HEAD` stands for: a commit or a read on it is a commit or a read on `HEAD` */
  defaultBranch?: string;
  /** The number the first pull request opened gets */
  firstPullRequest?: number;
  stats?: RepoStats;
}

export class FakeGitHub implements GitHubSource, GitHubWriter, BlogRepo, ReviewGitHub {
  /** Text files by `owner/name/path@ref`; tests read and write it directly */
  readonly files: Record<string, string>;
  /** Binary files a pull request or a commit carried, by the same key */
  readonly blobs: Record<string, Uint8Array> = {};
  readonly calls: GitHubCall[] = [];
  readonly opened: PullRequestDraft[] = [];
  readonly commits: Array<{ repo: string; branch: string; message: string; files: CommitFile[]; sha: string }> = [];
  readonly updates: Array<{ repo: string; branch: string; path: string; content: string; message: string }> = [];
  readonly merged: number[] = [];
  readonly pulls = new Map<string, FakePullRequest>();
  events: EventsPage[];
  latest: { tag: string; url: string } | undefined;
  /** The state of a pull request the fake was not given; tests flip it to merge */
  state: PullRequestState;
  stats: RepoStats;
  readonly defaultBranchName: string;
  #next: number;
  readonly #failures = new Map<GitHubMethod, Error>();

  constructor(options: FakeGitHubOptions = {}) {
    this.files = { ...options.files };
    this.events = [...(options.events ?? [])];
    this.latest = options.latestRelease;
    this.state = options.pullRequestState ?? 'open';
    this.defaultBranchName = options.defaultBranch ?? 'main';
    this.#next = options.firstPullRequest ?? 1;
    this.stats = options.stats ?? { stars: 0, forks: 0, watchers: 0 };
  }

  static key(repo: string, path: string, ref = 'HEAD'): string {
    return `${repo}/${path}@${ref}`;
  }

  /** The default branch is one ref however it is named, as GitHub reads it */
  #ref(ref: string): string {
    return ref === this.defaultBranchName ? 'HEAD' : ref;
  }

  #record(method: GitHubMethod, args: unknown[]): void {
    this.calls.push({ method, args });
    const failure = this.#failures.get(method);
    if (failure) throw failure;
  }

  setFile(repo: string, path: string, content: string, ref = 'HEAD'): this {
    this.files[FakeGitHub.key(repo, path, this.#ref(ref))] = content;
    return this;
  }

  /** A file as the fake holds it, without counting as a call */
  file(repo: string, path: string, ref = 'HEAD'): string | undefined {
    return this.files[FakeGitHub.key(repo, path, this.#ref(ref))];
  }

  /** Every later call of `method` throws `error`, until `failOn(method)` clears it */
  failOn(method: GitHubMethod, error?: Error): this {
    if (error) this.#failures.set(method, error);
    else this.#failures.delete(method);
    return this;
  }

  /** The arguments of each call of one method, in order */
  called(method: GitHubMethod): unknown[][] {
    return this.calls.filter((c) => c.method === method).map((c) => c.args);
  }

  addPullRequest(pr: Partial<FakePullRequest> & Pick<FakePullRequest, 'repo' | 'number'>): FakePullRequest {
    const full: FakePullRequest = { branch: `pr-${pr.number}`, base: this.defaultBranchName, title: '', body: '', state: 'open', files: [], ...pr };
    this.pulls.set(`${pr.repo}#${pr.number}`, full);
    this.#next = Math.max(this.#next, pr.number + 1);
    return full;
  }

  #pull(repo: string, number: number): FakePullRequest {
    const pr = this.pulls.get(`${repo}#${number}`);
    if (!pr) throw new GitHubError(`GitHub pull request ${repo}#${number}: 404`, 404);
    return pr;
  }

  #write(repo: string, ref: string, files: CommitFile[]): void {
    for (const f of files) {
      const key = FakeGitHub.key(repo, f.path, this.#ref(ref));
      if ('delete' in f) {
        delete this.files[key];
        delete this.blobs[key];
      } else if ('content' in f) this.files[key] = f.content;
      else this.blobs[key] = f.bytes;
    }
  }

  async userEvents(owner: string, etag?: string): Promise<EventsPage> {
    this.#record('userEvents', [owner, etag]);
    return this.events.shift() ?? { notModified: true };
  }

  async fileAt(repo: string, path: string, ref: string): Promise<string | undefined> {
    this.#record('fileAt', [repo, path, ref]);
    return this.file(repo, path, ref);
  }

  async latestRelease(repo: string): Promise<{ tag: string; url: string } | undefined> {
    this.#record('latestRelease', [repo]);
    return this.latest;
  }

  async pullRequestState(repo: string, number: number): Promise<PullRequestState> {
    this.#record('pullRequestState', [repo, number]);
    return this.pulls.get(`${repo}#${number}`)?.state ?? this.state;
  }

  /** As GitHub's: the open pull request of the same branch is answered instead of a second one */
  async openPullRequest(draft: PullRequestDraft): Promise<{ number: number; url: string; created: boolean }> {
    this.#record('openPullRequest', [draft]);
    const url = (n: number) => `https://github.com/${draft.repo}/pull/${n}`;
    const existing = [...this.pulls.values()].find((p) => p.repo === draft.repo && p.branch === draft.branch && p.state === 'open');
    if (existing) return { number: existing.number, url: url(existing.number), created: false };
    this.opened.push(draft);
    const number = this.#next++;
    this.addPullRequest({ repo: draft.repo, number, branch: draft.branch, base: draft.base, title: draft.title, body: draft.body, files: draft.files.map((f) => f.path) });
    this.#write(draft.repo, draft.branch, draft.files);
    return { number, url: url(number), created: true };
  }

  async commitToBranch(repo: string, branch: string, message: string, files: CommitFile[]): Promise<{ sha: string }> {
    this.#record('commitToBranch', [repo, branch, message, files]);
    const sha = `sha${this.commits.length + 1}`;
    this.commits.push({ repo, branch, message, files, sha });
    this.#write(repo, branch, files);
    return { sha };
  }

  async filesUnder(repo: string, ref: string, folder: string): Promise<string[]> {
    this.#record('filesUnder', [repo, ref, folder]);
    const prefix = `${repo}/${folder}/`;
    const suffix = `@${this.#ref(ref)}`;
    return [...Object.keys(this.files), ...Object.keys(this.blobs)]
      .filter((k) => k.startsWith(prefix) && k.endsWith(suffix))
      .map((k) => k.slice(repo.length + 1, -suffix.length))
      .sort();
  }

  async pullRequest(repo: string, number: number): Promise<{ number: number; url: string; state: PullRequestState; branch: string; title: string }> {
    this.#record('pullRequest', [repo, number]);
    const pr = this.#pull(repo, number);
    return { number, url: `https://github.com/${repo}/pull/${number}`, state: pr.state, branch: pr.branch, title: pr.title };
  }

  async pullRequestFiles(repo: string, number: number): Promise<string[]> {
    this.#record('pullRequestFiles', [repo, number]);
    return [...this.#pull(repo, number).files];
  }

  async updateFile(repo: string, branch: string, path: string, content: string, message: string): Promise<void> {
    this.#record('updateFile', [repo, branch, path, content, message]);
    this.updates.push({ repo, branch, path, content, message });
    this.setFile(repo, path, content, branch);
  }

  /** Merging lands the branch's files on the default branch, as the deploy then sees them */
  async mergePullRequest(repo: string, number: number, title: string): Promise<{ sha: string }> {
    this.#record('mergePullRequest', [repo, number, title]);
    const pr = this.#pull(repo, number);
    pr.state = 'merged';
    this.merged.push(number);
    for (const path of pr.files) {
      const from = FakeGitHub.key(repo, path, pr.branch);
      const to = FakeGitHub.key(repo, path);
      if (this.files[from] !== undefined) this.files[to] = this.files[from];
      if (this.blobs[from] !== undefined) this.blobs[to] = this.blobs[from];
    }
    return { sha: `merge${number}` };
  }

  async repoStats(repo: string): Promise<RepoStats> {
    this.#record('repoStats', [repo]);
    return { ...this.stats };
  }

  async defaultBranch(repo: string): Promise<string> {
    this.#record('defaultBranch', [repo]);
    return this.defaultBranchName;
  }
}
