import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatSnapshot, openSnapshot, parseSnapshot, type Registry } from '@shipcast/engine';

/*
 * Action mode's registry between runs (docs/decisions/action-mode.md): a JSON snapshot on an orphan
 * branch of the launches repo, guarded by a lease. The lease is a `lock.json` committed on top of the
 * branch and pushed without force: GitHub refuses a push that is not a fast-forward, so of two runs
 * racing for it exactly one lands, whichever repo each runs in.
 */

export const STATE_BRANCH = 'shipcast-state';
export const REGISTRY_FILE = 'registry.json';
export const LOCK_FILE = 'lock.json';

/** Who holds the state, and until when */
export interface StateLock {
  holder: string;
  command: string;
  since: string;
  expires: string;
}

/** The branch's tip as fetched: its commit, the snapshot's text and the lease, each absent until first written */
export interface StateTip {
  sha: string | undefined;
  registry: string | undefined;
  lock: StateLock | undefined;
}

/** Where the state is kept: read the tip, and write a child of a given commit unless the branch moved */
export interface StateStore {
  read(): Promise<StateTip>;
  /** `parent` undefined writes the branch's first commit; `ok: false` when the branch is not at `parent` any more */
  write(parent: string | undefined, files: { registry: string | undefined; lock: StateLock | undefined }, message: string): Promise<{ ok: true; sha: string } | { ok: false }>;
}

export class LeaseTimeout extends Error {}
export class LostLease extends Error {}

const README = `# Shipcast's state

This branch is written by Shipcast's GitHub Action mode, never by hand: \`${REGISTRY_FILE}\` is the
launch registry (which releases were launched, their pieces and where they went), \`${LOCK_FILE}\`
says which run is using it. It holds no secret. See docs/decisions/action-mode.md in Shipcast.
`;

function run(args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; input?: string }): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // stdin only for the commands that read it: writing to one that has already exited is an EPIPE
    const child = spawn('git', args, { cwd: options.cwd, env: options.env, stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
}

/** git output that means the branch moved under the push, as opposed to a network or permission failure */
export function isRejectedPush(stderr: string): boolean {
  // Two first runs creating the branch at once: the loser is told the ref exists, not that its push
  // is behind, and it lost the same race
  return /\[rejected\]|non-fast-forward|fetch first|stale info|failed to update ref|cannot lock ref|reference already exists/i.test(stderr);
}

export interface GitStateOptions {
  /** `https://github.com/<owner>/<repo>.git`, or a path for tests */
  remote: string;
  branch?: string;
  /** A token for GitHub over HTTPS, asked for on each fetch and push: an App's installation token expires */
  token?: () => Promise<string | undefined>;
  /** Who the state's commits are by */
  author?: { name: string; email: string };
}

/**
 * The state branch through the git command line, in a scratch repository of its own: a shallow fetch
 * of the tip, plumbing to write a commit (no worktree, no checkout), and a push without force. The
 * token goes in through git's environment configuration, never in a URL or an argument.
 */
export class GitStateStore implements StateStore {
  readonly #options: GitStateOptions;
  readonly #branch: string;
  #dir: string | undefined;

  constructor(options: GitStateOptions) {
    this.#options = options;
    this.#branch = options.branch ?? STATE_BRANCH;
  }

  async #env(): Promise<NodeJS.ProcessEnv> {
    const author = this.#options.author ?? { name: 'Shipcast', email: 'shipcast@users.noreply.github.com' };
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      // Its messages are matched below (a missing branch, a refused push), so never translated
      LC_ALL: 'C',
      LANGUAGE: 'C',
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: author.email,
      GIT_COMMITTER_NAME: author.name,
      GIT_COMMITTER_EMAIL: author.email,
    };
    const token = await this.#options.token?.();
    if (token) {
      // What actions/checkout does: an Authorization header for github.com, set through the environment
      env.GIT_CONFIG_COUNT = '1';
      env.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader';
      env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
    }
    return env;
  }

  async #git(args: string[], input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
    if (!this.#dir) {
      this.#dir = await mkdtemp(join(tmpdir(), 'shipcast-state-'));
      const init = await run(['init', '-q', '--bare', this.#dir], { cwd: this.#dir, env: process.env });
      if (init.code !== 0) throw new Error(`git init failed: ${init.stderr.trim()}`);
    }
    return run(args, { cwd: this.#dir, env: await this.#env(), ...(input !== undefined && { input }) });
  }

  async #ok(args: string[], input?: string): Promise<string> {
    const result = await this.#git(args, input);
    if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
    return result.stdout;
  }

  async read(): Promise<StateTip> {
    const ref = `refs/remotes/origin/${this.#branch}`;
    const fetched = await this.#git(['fetch', '-q', '--depth=1', this.#options.remote, `+refs/heads/${this.#branch}:${ref}`]);
    if (fetched.code !== 0) {
      if (/couldn't find remote ref|could not find remote ref/i.test(fetched.stderr)) return { sha: undefined, registry: undefined, lock: undefined };
      throw new Error(`could not fetch the state branch ${this.#branch}: ${fetched.stderr.trim()}`);
    }
    const sha = (await this.#ok(['rev-parse', ref])).trim();
    const names = (await this.#ok(['ls-tree', '--name-only', sha])).split('\n');
    const file = async (name: string) => (names.includes(name) ? this.#ok(['show', `${sha}:${name}`]) : undefined);
    const lockText = await file(LOCK_FILE);
    return { sha, registry: await file(REGISTRY_FILE), lock: lockText ? (JSON.parse(lockText) as StateLock) : undefined };
  }

  async write(parent: string | undefined, files: { registry: string | undefined; lock: StateLock | undefined }, message: string): Promise<{ ok: true; sha: string } | { ok: false }> {
    const entries: Array<[string, string]> = [['README.md', README]];
    if (files.registry !== undefined) entries.push([REGISTRY_FILE, files.registry]);
    if (files.lock) entries.push([LOCK_FILE, `${JSON.stringify(files.lock, null, 2)}\n`]);
    const lines: string[] = [];
    for (const [name, content] of entries) {
      const blob = (await this.#ok(['hash-object', '-w', '--stdin'], content)).trim();
      lines.push(`100644 blob ${blob}\t${name}`);
    }
    const tree = (await this.#ok(['mktree'], `${lines.join('\n')}\n`)).trim();
    const commit = (await this.#ok(['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message])).trim();
    const pushed = await this.#git(['push', '-q', this.#options.remote, `${commit}:refs/heads/${this.#branch}`]);
    if (pushed.code === 0) return { ok: true, sha: commit };
    if (isRejectedPush(pushed.stderr)) return { ok: false };
    throw new Error(`could not push the state branch ${this.#branch}: ${pushed.stderr.trim()}`);
  }

  async close(): Promise<void> {
    if (this.#dir) await rm(this.#dir, { recursive: true, force: true });
    this.#dir = undefined;
  }
}

/** A run holding the lease: the commit it wrote last, and the snapshot it found */
export interface Held {
  sha: string;
  registry: string | undefined;
  lock: StateLock;
}

export interface LeaseOptions {
  holder: string;
  command: string;
  /** How long a lease lasts without being renewed; a run killed by the runner frees the state after it */
  leaseMs: number;
  /** How long to wait for another run's lease before giving up */
  waitMs: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

function lockFor(options: LeaseOptions, now: number): StateLock {
  return { holder: options.holder, command: options.command, since: new Date(now).toISOString(), expires: new Date(now + options.leaseMs).toISOString() };
}

/**
 * Takes the lease: waits while another run holds an unexpired one, then commits this run's lock on
 * the tip and pushes it. A push refused because the branch moved means another run got there first,
 * so the tip is read again.
 */
export async function acquireLease(store: StateStore, options: LeaseOptions): Promise<Held> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const deadline = now() + options.waitMs;
  let told = false;
  for (;;) {
    const tip = await store.read();
    const other = tip.lock && tip.lock.holder !== options.holder && Date.parse(tip.lock.expires) > now() ? tip.lock : undefined;
    if (other) {
      if (now() >= deadline) {
        throw new LeaseTimeout(`the state is held by ${other.holder} (${other.command}) since ${other.since}, until ${other.expires} at the latest; gave up waiting`);
      }
      if (!told) options.log?.(`Waiting for ${other.holder} (${other.command}) to finish with the state...`);
      told = true;
      await sleep(options.pollMs ?? 15_000);
      continue;
    }
    if (tip.lock && tip.lock.holder !== options.holder) options.log?.(`Taking over the state from ${tip.lock.holder}, whose lease expired at ${tip.lock.expires}`);
    const lock = lockFor(options, now());
    const written = await store.write(tip.sha, { registry: tip.registry, lock }, `lock: ${options.command} by ${options.holder}`);
    if (written.ok) return { sha: written.sha, registry: tip.registry, lock };
  }
}

/**
 * Saves the registry as a child of the run's last commit: renewing the lease, or releasing it. A
 * refused push means the branch moved while this run held it, which only happens when its lease
 * expired and another run took over: nothing is overwritten, and the run stops.
 */
export async function saveState(store: StateStore, held: Held, registry: string | undefined, options: LeaseOptions & { release: boolean; message: string }): Promise<Held> {
  const now = options.now ?? Date.now;
  const lock = options.release ? undefined : lockFor(options, now());
  const written = await store.write(held.sha, { registry, lock }, options.message);
  if (!written.ok) throw new LostLease(`the state branch moved while this run held its lease (it expired, and another run took over): what this run did is not saved`);
  return { sha: written.sha, registry, lock: lock ?? held.lock };
}

/** Where a `shipcast ci` run keeps the registry: one lease per `use`, or a Postgres of the owner's */
export interface CiState {
  /** Runs `work` on the registry and saves what it changed, even when it throws; `command` names the run in the lease */
  use<T>(work: (registry: Registry) => Promise<T>, command?: string): Promise<T>;
  /** Runs `work` on a copy that is never saved, outside the lease: for the minutes an AI draft takes */
  scratch<T>(work: (registry: Registry) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface BranchStateOptions extends Omit<LeaseOptions, 'command'> {
  /** Reads, never writes: no lease is taken and nothing is pushed */
  dryRun?: boolean;
}

/** The state branch: each `use` takes the lease, loads the snapshot, runs, saves and releases */
export class BranchState implements CiState {
  readonly #store: StateStore & { close?(): Promise<void> };
  readonly #options: BranchStateOptions;

  constructor(store: StateStore & { close?(): Promise<void> }, options: BranchStateOptions) {
    this.#store = store;
    this.#options = options;
  }

  async #open(text: string | undefined) {
    return openSnapshot(text === undefined ? undefined : parseSnapshot(text));
  }

  async scratch<T>(work: (registry: Registry) => Promise<T>): Promise<T> {
    const tip = await this.#store.read();
    const open = await this.#open(tip.registry);
    try {
      return await work(open.registry);
    } finally {
      await open.close();
    }
  }

  async use<T>(work: (registry: Registry) => Promise<T>, command = 'shipcast ci'): Promise<T> {
    if (this.#options.dryRun) return this.scratch(work);
    const lease = { ...this.#options, command };
    const held = await acquireLease(this.#store, lease);
    let open;
    try {
      open = await this.#open(held.registry);
    } catch (error) {
      // A state this run cannot read is left as it was, lease released
      await saveState(this.#store, held, held.registry, { ...lease, release: true, message: 'unlock: the state could not be read' });
      throw error;
    }
    let result: { ok: true; value: T } | { ok: false; error: unknown };
    try {
      result = { ok: true, value: await work(open.registry) };
    } catch (error) {
      result = { ok: false, error };
    }
    try {
      const text = formatSnapshot(await open.dump());
      await saveState(this.#store, held, text, { ...lease, release: true, message: `state: ${command}` });
    } finally {
      await open.close();
    }
    if (!result.ok) throw result.error;
    return result.value;
  }

  async close(): Promise<void> {
    await this.#store.close?.();
  }
}

/** The owner's own Postgres: the claim's `ON CONFLICT` is the guarantee, as in the local install */
export class PostgresState implements CiState {
  readonly #registry: Registry;

  constructor(registry: Registry) {
    this.#registry = registry;
  }

  use<T>(work: (registry: Registry) => Promise<T>): Promise<T> {
    return work(this.#registry);
  }

  scratch<T>(work: (registry: Registry) => Promise<T>): Promise<T> {
    return work(this.#registry);
  }

  async close(): Promise<void> {
    await this.#registry.close();
  }
}
