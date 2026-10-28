import { createHash } from 'node:crypto';
import { LruEtagCache, type EtagCache, type EtagEntry } from '@shipcast/connectors';
import type { DraftSnapshotService, FileCache, Repositories } from '@shipcast/engine';
import { PROJECTS_PATH } from '@shipcast/schema';
import type { Cache, Json } from './redis/ports.ts';
import { MemoryCache } from './redis/memory.ts';

/*
 * GitHub by events (docs/plans/performance-refactor.md, phase 7, behind the `github-events` flag):
 * every GitHub GET is conditional through an ETag cache, and the few files the engine reads over and
 * over (brand.yml, projects.yml, a launch's launch.yml and pack.json) are kept until a push, one of
 * Shipcast's own commits or the hourly poll says they changed. Both live in the shared Cache when
 * there is one (Redis, so every replica's 304 serves every other), in this process otherwise.
 */

/** A week: an entry nobody reads again ages out; one read proves itself with a 304 anyway */
const ETAG_TTL_SECONDS = 7 * 86_400;

const digest = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32);

/** The ETag cache on the shared Cache: keys hashed, since a URL and its scope can be long */
export class CacheEtagStore implements EtagCache {
  readonly #cache: Cache;

  constructor(cache: Cache) {
    this.#cache = cache;
  }

  async get(key: string): Promise<EtagEntry | undefined> {
    return (await this.#cache.get(`github-etag:${digest(key)}`)) as EtagEntry | undefined;
  }

  async set(key: string, entry: EtagEntry): Promise<void> {
    await this.#cache.set(`github-etag:${digest(key)}`, entry as unknown as Json, ETAG_TTL_SECONDS);
  }
}

/** A day: past it a kept file is read again (a 304, through the ETag cache) even with no event */
const FILE_TTL_SECONDS = 86_400;

const norm = (repo: string) => repo.toLowerCase();

/**
 * The FileCache policy and store. Kept: on the launches repo's default branch, brand.yml,
 * projects.yml and a launch folder's launch.yml and pack.json; in any repo, `.github/launch.yml` at
 * a release's tag. Each repo is a namespace of the versioned Cache, so forgetting a whole repo (a
 * merge, a push too long to list, the hourly poll) is one bump on every replica at once.
 */
export class GitHubFileCache implements FileCache {
  readonly #cache: Cache;
  readonly #launchesRepo: () => string | undefined;

  constructor(cache: Cache, launchesRepo: () => string | undefined) {
    this.#cache = cache;
    this.#launchesRepo = launchesRepo;
  }

  keeps(repo: string, path: string, ref: string): boolean {
    const launches = this.#launchesRepo();
    if (launches && norm(repo) === norm(launches) && ref === 'HEAD') {
      return path === 'brand.yml' || path === PROJECTS_PATH || path.endsWith('/launch.yml') || path.endsWith('/pack.json');
    }
    // A tag's launch.yml: what a release launch publishes by, which a release does not move
    return path === '.github/launch.yml' && ref !== 'HEAD';
  }

  async get(repo: string, path: string, ref: string): Promise<string | undefined> {
    return this.#cache.get<string>(await this.#key(repo, path, ref));
  }

  async set(repo: string, path: string, ref: string, text: string): Promise<void> {
    await this.#cache.set(await this.#key(repo, path, ref), text, FILE_TTL_SECONDS);
  }

  async forget(repo: string, paths?: readonly string[]): Promise<void> {
    if (!paths) {
      await this.#cache.bump(this.#namespace(repo));
      return;
    }
    // A push moves the default branch: only its files are named here, a tag's are left alone
    for (const path of paths) await this.#cache.delete(await this.#key(repo, path, 'HEAD'));
  }

  #namespace(repo: string): string {
    return `github-files:${norm(repo)}`;
  }

  #key(repo: string, path: string, ref: string): Promise<string> {
    return this.#cache.versioned(this.#namespace(repo), `${ref}:${path}`);
  }
}

/** The two caches GitHubRest takes with the flag on */
export interface GitHubCaches {
  etags: EtagCache;
  files: GitHubFileCache;
}

/**
 * The caches on the shared Cache when the composition hands one in (Redis with `redis-state`), or
 * in this process: an LRU for the ETags, whose bodies can add up, and the in-memory Cache for the
 * few files, which cannot.
 */
export function githubCaches(cache: Cache | undefined, launchesRepo: () => string | undefined): GitHubCaches {
  return {
    etags: cache ? new CacheEtagStore(cache) : new LruEtagCache(),
    files: new GitHubFileCache(cache ?? new MemoryCache(), launchesRepo),
  };
}

/** What a delivery changes in what Shipcast holds of GitHub: a snapshot to read again, files to forget */
export interface GitHubEventEffects {
  /** The launches repo's pull request whose snapshot is read again, by a job */
  snapshot?: number;
  /** Files kept from this repo that the push changed; every file of it when `paths` is absent */
  forget?: { repo: string; paths?: string[] };
}

interface EventPayload {
  action?: string;
  ref?: string;
  forced?: boolean;
  repository?: { full_name?: string; default_branch?: string };
  pull_request?: { number?: number };
  commits?: Array<{ added?: string[]; modified?: string[]; removed?: string[] }>;
}

/** The pull request actions that change what the page shows: its files, its title or its state */
const SNAPSHOT_ACTIONS = new Set(['opened', 'reopened', 'synchronize', 'edited', 'closed']);
/** GitHub lists at most this many commits in a push; past it the paths are not all known */
const PUSH_COMMITS_LISTED = 20;

/**
 * Decided from the delivery alone, like webhookAction, and as cheap: the webhook applies the
 * forgetting inline (a cache delete) and queues the snapshot's read, so the answer stays immediate.
 */
export function githubEventEffects(event: string | null, payload: EventPayload, launchesRepo: string): GitHubEventEffects {
  const repo = payload.repository?.full_name;
  if (!repo) return {};
  if (event === 'pull_request') {
    const number = payload.pull_request?.number;
    if (norm(repo) !== norm(launchesRepo) || !number || !SNAPSHOT_ACTIONS.has(payload.action ?? '')) return {};
    return { snapshot: number };
  }
  if (event !== 'push' || !payload.ref) return {};
  // A tag moved or made: a release's launch.yml read at it may have changed
  if (payload.ref.startsWith('refs/tags/')) return { forget: { repo } };
  const branch = payload.repository?.default_branch;
  if (!branch || payload.ref !== `refs/heads/${branch}`) return {};
  const commits = payload.commits ?? [];
  // A force-push or a push longer than GitHub lists: which files moved is not known, so all of them
  if (payload.forced || commits.length >= PUSH_COMMITS_LISTED) return { forget: { repo } };
  const paths = [...new Set(commits.flatMap((c) => [...(c.added ?? []), ...(c.modified ?? []), ...(c.removed ?? [])]))];
  return paths.length > 0 ? { forget: { repo, paths } } : {};
}

/** The cursor of the last hourly GitHub poll: shared through the registry, so every process agrees */
export const GITHUB_POLL_KEY = 'github-poll-at';
export const GITHUB_POLL_MS = 3600_000;

/**
 * Whether the hourly poll is due, and if so marks it taken: with `github-events` GitHub is read on
 * deliveries, and the poll (detection, the open pull requests) is only the safety net for missed
 * ones, at most once an hour however often the rounds run. Rounds are one at a time, so the read
 * and the mark need no lock.
 */
export async function takeGitHubPoll(registry: Pick<Repositories, 'cursors'>, now: Date = new Date()): Promise<boolean> {
  const last = Date.parse((await registry.cursors.cursor(GITHUB_POLL_KEY)) ?? '');
  if (Number.isFinite(last) && now.getTime() - last < GITHUB_POLL_MS) return false;
  await registry.cursors.setCursor(GITHUB_POLL_KEY, now.toISOString());
  return true;
}

/**
 * The poll's own reads, after the round's detection: every open pull request's snapshot read again
 * (304s when nothing changed), and the launches repo's kept files forgotten, so each is proven
 * current by its next read's ETag rather than trusted on for ever when a push was missed.
 */
export async function pollGitHub(d: { drafts: Pick<DraftSnapshotService, 'refreshOpen'>; files: Pick<FileCache, 'forget'> | undefined; launchesRepo: string }): Promise<string[]> {
  if (d.launchesRepo) await d.files?.forget(d.launchesRepo);
  const { refreshed, problems } = await d.drafts.refreshOpen();
  return [`GitHub poll: ${refreshed} drafts pull requests read`, ...problems.map((p) => `  ${p}`)];
}
