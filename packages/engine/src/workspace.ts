import { execFile } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * The folder shared with the AI provider: the engine clones into `hostDir`, and the provider sees the
 * same folder as `providerDir` (claudio mounts `./workspace` as `/workspace`, docs/claudio.md).
 */
export interface Workspace {
  hostDir: string;
  providerDir: string;
  /** Where a repo is cloned from; GitHub over HTTPS unless a test points elsewhere */
  cloneUrl?: (repo: string) => string;
}

export interface Checkout {
  /** The clone, as the engine sees it */
  hostPath: string;
  /** The same clone, as the provider sees it: the `cwd` of the generation */
  providerPath: string;
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
  const name = checkoutName(repo, ref);
  const hostPath = join(workspace.hostDir, name);
  await mkdir(workspace.hostDir, { recursive: true });
  await rm(hostPath, { recursive: true, force: true });

  const url = workspace.cloneUrl?.(repo) ?? `https://github.com/${repo}.git`;
  const args = ['clone', '--depth', '1', '--quiet'];
  if (ref !== 'HEAD') args.push('--branch', ref);
  await run('git', [...args, url, hostPath], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });

  return { hostPath, providerPath: `${workspace.providerDir.replace(/\/+$/, '')}/${name}` };
}
