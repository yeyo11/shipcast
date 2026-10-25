import { approveLaunch, claimArticle, claimManual, preflight, type ArticleInput, type Launch } from '@shipcast/engine';
import type { Channel } from '@shipcast/schema';
import { startDrafting, startPublishing as queuePublishing } from '@shipcast/runtime';
import { appContext } from './context.server';

/*
 * What the owner starts from the app becomes a job of the queue: it runs in this process (or in
 * `shipcast watch`), survives a restart, and its row is what the pages show.
 */

type Started = { ok: true; job: string } | { ok: false; problem: string };

/**
 * Queues the publishing of a launch once its drafts are on main; retries wait for the site to
 * deploy. A launch already being published answers with that job.
 */
export async function startPublishing(launch: Launch, retryChannel?: Channel): Promise<string> {
  const job = await queuePublishing((await appContext()).queue, launch, retryChannel);
  if (!job) throw new Error('the publishing could not be queued');
  return job;
}

/** Drafts a repo's launch after its pre-flight passes; publishing directly goes on to publish */
export async function startLaunch(repo: string, ref: string | undefined, direct: boolean): Promise<Started> {
  const { queue, deps, github, brand } = await appContext();
  const check = await preflight(repo, ref, { github });
  if (!check.ok) return { ok: false, problem: check.checks.filter((c) => !c.ok && c.required).map((c) => c.detail).join(' ') };
  const claim = await claimManual(repo, ref, await brand(), deps);
  if ('error' in claim) return { ok: false, problem: claim.error };
  if (!claim.claimed) return { ok: false, problem: `${repo} ${claim.launch.ref} was launched already (${claim.launch.status}).` };
  const job = await startDrafting(queue, claim.launch, direct);
  return job ? { ok: true, job } : { ok: false, problem: 'the drafting could not be queued' };
}

/** Drafts an article written in the app; publishing directly goes on to publish */
export async function startArticle(input: ArticleInput, direct: boolean): Promise<Started> {
  const { queue, deps, brand } = await appContext();
  const claim = await claimArticle(input, await brand(), deps);
  if (!claim.claimed && claim.launch.status !== 'failed') return { ok: false, problem: `An article titled like this exists already (${claim.launch.status}). Change the title.` };
  const job = await queue.send('article', { launchId: claim.launch.id, input, direct }, { title: `Writing the pieces for “${input.title}”`, launchId: claim.launch.id });
  return job ? { ok: true, job } : { ok: false, problem: 'the article could not be queued' };
}

/** Approving merges the pull request; publishing follows as a job */
export async function approve(launchId: number): Promise<Started> {
  const { registry, deps, github } = await appContext();
  const launch = await registry.get(launchId);
  if (!launch) return { ok: false, problem: 'no such launch' };
  try {
    await approveLaunch(launch, { github, launchesRepo: deps.launchesRepo });
  } catch (error) {
    return { ok: false, problem: error instanceof Error ? error.message : String(error) };
  }
  return { ok: true, job: await startPublishing(launch) };
}
