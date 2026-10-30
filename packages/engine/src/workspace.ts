import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Where the engine clones a release: the AI task runner's tools read the clone here. No AI provider
 * shares this folder; a remote agent (Claudio) makes a workspace of its own from the repo's archive.
 */
export interface Workspace {
  hostDir: string;
  /** Where a repo is cloned from; GitHub over HTTPS unless a test points elsewhere */
  cloneUrl?: (repo: string) => string;
  /**
   * A folder of its own for every clone, removed when the job that made it ends (withJobWorkspace):
   * what processes side by side need, since two jobs of one repo and ref would otherwise share a
   * folder and each delete the other's clone. Off, one folder per repo and ref, kept until the next
   * clone of it, as a single process has always done
   */
  perJob?: boolean;
}

/** The clones a running job made, removed when it ends */
const jobClones = new AsyncLocalStorage<Set<string>>();

/**
 * Runs a job's work so that every per-job clone it makes is removed at its end, however it ends.
 * A clone made outside one (the CLI drafting in its own process) is left as before.
 */
export async function withJobWorkspace<T>(work: () => Promise<T>): Promise<T> {
  const clones = new Set<string>();
  try {
    return await jobClones.run(clones, work);
  } finally {
    await Promise.all([...clones].map((path) => rm(path, { recursive: true, force: true }).catch(() => undefined)));
  }
}

export interface Checkout {
  /** The clone on this machine */
  hostPath: string;
}

/** `yeyo11/claudio` at `v0.9.0` → `yeyo11__claudio@v0.9.0`: one folder per launch, never shared. */
export function checkoutName(repo: string, ref: string): string {
  return `${repo.replace('/', '__')}@${ref}`.replace(/[^A-Za-z0-9._@-]/g, '_');
}

/**
 * A fresh shallow clone of the repo at the launch's ref (a tag, or `HEAD` for the default branch).
 * Shallow because the analysis reads the code as released, not its history, and a fresh folder each
 * time so a previous run can never leak into this one.
 */
export async function checkout(workspace: Workspace, repo: string, ref: string): Promise<Checkout> {
  const hostPath = await jobFolder(workspace, checkoutName(repo, ref));
  await cloneInto(workspace, repo, ref, hostPath);
  return { hostPath };
}

/**
 * A fresh, empty folder of the workspace under a name: per job (removed with the job's clones) when
 * the workspace is, or one per name kept until the next use of it. Where a clone goes, and where a
 * launch made from sources gathers its bundle (sources/bundle.ts).
 */
export async function jobFolder(workspace: Workspace, name: string): Promise<string> {
  const clones = workspace.perJob ? jobClones.getStore() : undefined;
  const hostPath = join(workspace.hostDir, clones ? `${name}~${randomUUID()}` : name);
  clones?.add(hostPath);
  await mkdir(workspace.hostDir, { recursive: true });
  await rm(hostPath, { recursive: true, force: true });
  return hostPath;
}

/**
 * A shallow clone of the repo at a ref into a folder that does not exist yet, and the commit it is
 * at. With `sha`, the clone is moved to that commit when the ref has moved on since: what a second
 * analysis of a launch reads is the code the first one read.
 */
export async function cloneInto(workspace: Workspace, repo: string, ref: string, hostPath: string, sha?: string): Promise<{ sha: string }> {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  const url = workspace.cloneUrl?.(repo) ?? `https://github.com/${repo}.git`;
  const args = ['clone', '--depth', '1', '--quiet'];
  if (ref !== 'HEAD') args.push('--branch', ref);
  await run('git', [...args, url, hostPath], { env });
  const head = (await run('git', ['-C', hostPath, 'rev-parse', 'HEAD'])).stdout.trim();
  if (!sha || sha === head) return { sha: head };
  await run('git', ['-C', hostPath, 'fetch', '--depth', '1', '--quiet', 'origin', sha], { env });
  await run('git', ['-C', hostPath, 'checkout', '--quiet', '--detach', sha]);
  return { sha };
}

/** A bundle bigger than this is refused rather than held in memory and sent */
export const ARCHIVE_MAX_BYTES = 256 * 1024 * 1024;

/**
 * A folder as a gzip tarball without its `.git` folders: what a remote agent's workspace is made
 * from when no archive URL holds what it reads (Claudio refuses a tarball with a `.git` path).
 */
export async function archiveFolder(hostPath: string): Promise<Uint8Array<ArrayBuffer>> {
  const { stdout } = await run('tar', ['--exclude=.git', '-czf', '-', '-C', hostPath, '.'], { encoding: 'buffer', maxBuffer: ARCHIVE_MAX_BYTES });
  return new Uint8Array(stdout);
}
