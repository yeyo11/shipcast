import { createHash } from 'node:crypto';
import { LruEtagCache, type EtagCache, type EtagEntry } from '@shipcast/connectors';
import type { FileCache } from '@shipcast/engine';
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
