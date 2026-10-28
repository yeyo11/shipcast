import { claimEvent, claimManual, detect, type DraftResult, type GitHubEvent, type GitHubSource, type GitHubWriter, type Launch, type PublishResult, type Repositories } from '@shipcast/engine';
import type { Brand } from '@shipcast/schema';
import { launchOfPullRequest, webhookAction } from '../webhooks.ts';
import type { CiState } from './state.ts';

/*
 * What `shipcast ci launch | publish | round` do, over injected pieces so they test without GitHub,
 * an AI or a network: the CLI (apps/cli/src/ci.ts) builds the real ones from the environment.
 */

export interface CiDeps {
  launchesRepo: string;
  github: GitHubSource & GitHubWriter;
  state: CiState;
  brand(): Promise<Brand>;
  /** Drafts a claimed launch on the registry it is given (a scratch copy, outside the lease) */
  draft(launch: Launch, brand: Brand, registry: Repositories): Promise<DraftResult>;
  /** One try at publishing a drafted launch, on the leased registry */
  publish(launch: Launch, brand: Brand, registry: Repositories): Promise<PublishResult>;
  /** For a dry run: what publishing a launch would do, one line per channel */
  plan?(launch: Launch): Promise<string[]>;
  /** The AI a draft would use, in words, for a dry run */
  aiLabel: string;
  dryRun: boolean;
  log(line: string): void;
  sleep?(ms: number): Promise<void>;
}

/** What `ci launch` was asked to launch, from the workflow's event or from flags */
export type LaunchTarget = { kind: 'event'; event: GitHubEvent } | { kind: 'manual'; repo: string; ref: string | undefined } | { kind: 'ignore'; reason: string };

const REPO = /^[\w.-]+\/[\w.-]+$/;

interface EventPayload {
  inputs?: { repo?: string; ref?: string; tag?: string };
  repository?: { full_name?: string };
}

/**
 * Maps the workflow's trigger to a launch: a published release, the repo made public (the `public`
 * event, keyed as the GitHub App's webhook keys it, so both paths claim the same launch), or a manual
 * run (`workflow_dispatch`, or `--repo`/`--ref`), which launch.yml's `triggers.manual` must allow.
 */
export function launchTarget(input: { eventName?: string | undefined; payload?: unknown; repo?: string | undefined; ref?: string | undefined; currentRepo?: string | undefined }): LaunchTarget {
  const payload = (input.payload ?? {}) as EventPayload;
  if (input.repo || input.ref || input.eventName === 'workflow_dispatch') {
    const repo = input.repo || payload.inputs?.repo?.trim() || input.currentRepo;
    const ref = input.ref || payload.inputs?.ref?.trim() || payload.inputs?.tag?.trim() || undefined;
    if (!repo || !REPO.test(repo)) return { kind: 'ignore', reason: `a manual launch needs a repo as owner/name${repo ? `, not "${repo}"` : ''}` };
    return { kind: 'manual', repo, ref };
  }
  if (input.eventName === 'release') {
    const action = webhookAction('release', input.payload as Parameters<typeof webhookAction>[1], '');
    return action.kind === 'claim' ? { kind: 'event', event: action.event } : { kind: 'ignore', reason: action.kind === 'ignore' ? action.reason : 'not a release' };
  }
  if (input.eventName === 'public') {
    const repo = payload.repository?.full_name;
    if (!repo) return { kind: 'ignore', reason: 'the public event names no repository' };
    return { kind: 'event', event: { type: 'public', id: `webhook-public-${repo}`, repo, at: new Date().toISOString() } };
  }
  return { kind: 'ignore', reason: `the ${input.eventName ?? 'unnamed'} event does not start a launch; run on release, public or workflow_dispatch` };
}

export interface CiResult {
  code: number;
  /** For the action's outputs */
  outputs: Record<string, string>;
}

const nameOf = (launch: Launch) => `${launch.repo} ${launch.ref}`;

/** Drafts a launch outside the lease, then records how it ended under it */
async function draftAndRecord(deps: CiDeps, launch: Launch, brand: Brand): Promise<DraftResult> {
  deps.log(`Drafting ${nameOf(launch)} (${launch.kind} pack) with ${deps.aiLabel}; the analysis takes a few minutes...`);
  const result = await deps.state.scratch(async (scratch) => {
    try {
      return await deps.draft(launch, brand, scratch);
    } catch (error) {
      return { ok: false as const, launch, problems: [error instanceof Error ? error.message : String(error)] };
    }
  });
  await deps.state.use(async (registry) => {
    if (result.ok) await registry.launches.setStatus(launch.id, 'drafted', result.pullRequest);
    else await registry.launches.setStatus(launch.id, 'failed', result.problems.join('\n'));
  }, `record the draft of ${nameOf(launch)}`);
  if (result.ok) deps.log(`Drafted ${nameOf(launch)}: ${result.pullRequest}`);
  else deps.log(`Could not draft ${nameOf(launch)}:\n${result.problems.map((p) => `  ${p}`).join('\n')}`);
  return result;
}

/**
 * `ci launch`: claims the release under the lease and saves the claim before any AI runs, so a
 * re-run, another workflow or the round's polling sees it claimed; then drafts and records the
 * outcome. A release claimed already, or one launch.yml ignores, ends successfully with why.
 */
export async function ciLaunch(deps: CiDeps, target: LaunchTarget): Promise<CiResult> {
  if (target.kind === 'ignore') {
    deps.log(`Nothing to launch: ${target.reason}`);
    return { code: 0, outputs: { status: 'ignored' } };
  }
  const brand = await deps.brand();
  const claim = await deps.state.use(async (registry) => {
    if (target.kind === 'manual') {
      const manual = await claimManual(target.repo, target.ref, brand, { github: deps.github, registry });
      if ('error' in manual) return { result: 'error' as const, reason: manual.error };
      return manual.claimed ? { result: 'claimed' as const, launch: manual.launch } : { result: 'already' as const, launch: manual.launch };
    }
    const outcome = await claimEvent(target.event, { github: deps.github, registry, brand });
    if (outcome.result === 'claimed') return { result: 'claimed' as const, launch: outcome.launch };
    if (outcome.result === 'already-claimed') return { result: 'already' as const, launch: outcome.launch };
    if (outcome.result === 'invalid-config') return { result: 'error' as const, reason: outcome.launch.detail ?? 'launch.yml is invalid' };
    return { result: 'ignored' as const, reason: outcome.reason };
  }, 'claim a launch');

  if (claim.result === 'error') {
    deps.log(`Not launched: ${claim.reason}`);
    return { code: 1, outputs: { status: 'failed' } };
  }
  if (claim.result === 'ignored') {
    deps.log(`Not launched: ${claim.reason}`);
    return { code: 0, outputs: { status: 'ignored' } };
  }
  const { launch } = claim;
  const outputs = { 'launch-id': String(launch.id) };
  if (claim.result === 'already') {
    deps.log(`${nameOf(launch)} was launched already (${launch.status}${launch.detail ? `: ${launch.detail.split('\n')[0]}` : ''}); a launch happens once`);
    return { code: 0, outputs: { ...outputs, status: 'already-launched' } };
  }
  if (deps.dryRun) {
    deps.log(`Dry run: would claim ${nameOf(launch)} (${launch.kind} pack, trigger ${launch.trigger}), draft it with ${deps.aiLabel}, and open its drafts pull request in ${deps.launchesRepo}. Nothing was saved.`);
    return { code: 0, outputs: { ...outputs, status: 'dry-run' } };
  }
  deps.log(`Claimed ${nameOf(launch)}; the claim is saved, so this release is never launched twice`);
  const result = await draftAndRecord(deps, launch, brand);
  return result.ok ? { code: 0, outputs: { ...outputs, status: 'drafted', 'pull-request': result.pullRequest } } : { code: 1, outputs: { ...outputs, status: 'failed' } };
}

export interface PublishOptions {
  /** The merged drafts pull request's URL; without it, every drafted launch that is ready */
  pullRequest?: string | undefined;
  /** How long to keep trying while the blog deploys */
  waitMs: number;
  /** Between tries, as the queue's publish retries locally */
  retryMs?: number;
}

/** The merged pull request the workflow's `pull_request` event names, or why there is nothing to publish */
export function publishTarget(input: { eventName?: string | undefined; payload?: unknown; launchesRepo: string }): { pullRequest: string } | { ignore: string } | undefined {
  if (input.eventName !== 'pull_request' && input.eventName !== 'pull_request_target') return undefined;
  const action = webhookAction('pull_request', input.payload as Parameters<typeof webhookAction>[1], input.launchesRepo);
  return action.kind === 'publish' ? { pullRequest: action.pullRequestUrl } : { ignore: action.kind === 'ignore' ? action.reason : 'not a merge' };
}

/**
 * `ci publish`: publishes the launch of a merged drafts pull request (or every drafted launch), one
 * try per lease, waiting between tries while the merge's deploy has not put the article online.
 */
export async function ciPublish(deps: CiDeps, options: PublishOptions): Promise<CiResult> {
  const brand = await deps.brand();
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const retryMs = options.retryMs ?? 30_000;
  const deadline = Date.now() + options.waitMs;

  if (deps.dryRun) {
    await deps.state.scratch(async (registry) => {
      const launches = options.pullRequest ? [await launchOfPullRequest({ registry }, options.pullRequest)].filter((l) => l !== undefined) : (await registry.launches.recent(100)).filter((l) => l.status === 'drafted');
      if (launches.length === 0) deps.log('Dry run: no drafted launch to publish');
      for (const launch of launches) {
        deps.log(`Dry run: would publish ${nameOf(launch)} once its pull request is merged and its article is live (${launch.detail ?? ''})`);
        for (const line of (await deps.plan?.(launch)) ?? []) deps.log(`  ${line}`);
      }
    });
    return { code: 0, outputs: { status: 'dry-run' } };
  }

  for (let attempt = 1; ; attempt++) {
    const results = await deps.state.use(async (registry) => {
      const launches = options.pullRequest ? [await launchOfPullRequest({ registry }, options.pullRequest)].filter((l) => l !== undefined) : (await registry.launches.recent(100)).filter((l) => l.status === 'drafted');
      const out: PublishResult[] = [];
      for (const launch of launches) out.push(await deps.publish(launch, brand, registry));
      return out;
    }, 'publish');
    if (results.length === 0) {
      deps.log(options.pullRequest ? `No drafted launch has the pull request ${options.pullRequest}: published already, or not Shipcast's` : 'No drafted launch to publish');
      return { code: 0, outputs: { status: 'nothing' } };
    }
    for (const r of results) {
      if (r.state === 'waiting') deps.log(`${nameOf(r.launch)}: waiting, ${r.reason}`);
      else if (r.state === 'skipped') deps.log(`${nameOf(r.launch)}: its drafts pull request was closed without merging; not published`);
      else {
        deps.log(`${nameOf(r.launch)} ${r.state}:${r.posted.map((p) => `\n  ${p.channel} ${p.url}`).join('')}`);
        for (const p of r.problems) deps.log(`  ${p}`);
        for (const s of r.scheduled) deps.log(`  ${s.channel} scheduled for ${s.at}`);
      }
    }
    // Only the deploy is worth waiting for: an open pull request waits for the owner, not for time
    const deploying = results.filter((r) => r.state === 'waiting' && !/pull request is open|no drafts pull request/.test(r.reason));
    const partial = results.some((r) => r.state === 'partial');
    if (deploying.length === 0 || !options.pullRequest) {
      return { code: partial ? 1 : 0, outputs: { status: results.every((r) => r.state === 'published') ? 'published' : (results[0]?.state ?? 'nothing') } };
    }
    if (Date.now() + retryMs > deadline) {
      deps.log(`Still waiting after ${attempt} tries; the hourly round will publish it once the article is live`);
      return { code: 0, outputs: { status: 'waiting' } };
    }
    await sleep(retryMs);
  }
}

/**
 * `ci round`: what is ready to publish (a scheduled piece now due, a channel to retry, a deploy that
 * took longer), and with `detect` the brand's new releases polled from its public events, as
 * `shipcast watch` does, each claimed launch then drafted.
 */
export async function ciRound(deps: CiDeps, options: { detect: boolean }): Promise<CiResult> {
  const brand = await deps.brand();
  const run = <T>(work: (registry: Repositories) => Promise<T>) => (deps.dryRun ? deps.state.scratch(work) : deps.state.use(work, 'round'));
  const claimed = await run(async (registry) => {
    const fresh: Launch[] = [];
    if (options.detect) {
      for (const outcome of await detect({ github: deps.github, registry, brand })) {
        if (outcome.result === 'claimed') fresh.push(outcome.launch);
        else if (outcome.result === 'invalid-config') deps.log(`${outcome.event.repo}: ${outcome.launch.detail ?? 'invalid launch.yml'}`);
      }
    }
    for (const launch of (await registry.launches.recent(100)).filter((l) => l.status === 'drafted')) {
      if (deps.dryRun) {
        deps.log(`Dry run: would try to publish ${nameOf(launch)}`);
        for (const line of (await deps.plan?.(launch)) ?? []) deps.log(`  ${line}`);
        continue;
      }
      const r = await deps.publish(launch, brand, registry);
      if (r.state === 'published' || r.state === 'partial') {
        for (const p of r.posted) deps.log(`${nameOf(launch)} on ${p.channel}: ${p.url}`);
        for (const p of r.problems) deps.log(`${nameOf(launch)}: ${p}`);
      }
    }
    return fresh;
  });
  let failed = false;
  for (const launch of claimed) {
    if (deps.dryRun) {
      deps.log(`Dry run: would draft ${nameOf(launch)} with ${deps.aiLabel}`);
      continue;
    }
    if (!(await draftAndRecord(deps, launch, brand)).ok) failed = true;
  }
  return { code: failed ? 1 : 0, outputs: { status: 'done', claimed: String(claimed.length) } };
}
