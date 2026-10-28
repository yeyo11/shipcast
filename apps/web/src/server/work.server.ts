import { LaunchRefused, LaunchService, type ArticleInput, type Launch, type Post } from '@shipcast/engine';
import type { Channel } from '@shipcast/schema';
import { armScheduled, startDrafting, startPublishing as queuePublishing } from '@shipcast/runtime';
import { appContext } from './context.server';
import { fakeNetworks, PREVIEW_REFUSAL } from './preview.server';

/*
 * What the owner starts from the app becomes a job of the queue: it runs in this process (or in
 * `shipcast watch`), survives a restart, and its row is what the pages show.
 */

type Started = { ok: true; job: string } | { ok: false; problem: string };

/** The engine's LaunchService over the app's registry, GitHub and pipeline */
async function launches(): Promise<LaunchService> {
  const { registry, deps, github } = await appContext();
  return new LaunchService({ launches: registry, claims: deps, github });
}

/** A refusal of the LaunchService as the answer's problem; anything else is a bug and is thrown */
async function started(run: () => Promise<Started>): Promise<Started> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof LaunchRefused) return { ok: false, problem: error.message };
    throw error;
  }
}

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
  if (fakeNetworks()) return { ok: false, problem: PREVIEW_REFUSAL };
  const { queue, brand } = await appContext();
  return started(async () => {
    const { launch } = await (await launches()).claimManual(repo, ref, brand);
    const job = await startDrafting(queue, launch, direct);
    return job ? { ok: true, job } : { ok: false, problem: 'the drafting could not be queued' };
  });
}

/** Drafts an article written in the app; publishing directly goes on to publish */
export async function startArticle(input: ArticleInput, direct: boolean): Promise<Started> {
  if (fakeNetworks()) return { ok: false, problem: PREVIEW_REFUSAL };
  const { queue, brand } = await appContext();
  return started(async () => {
    const launch = await (await launches()).claimArticle(input, await brand());
    const job = await queue.send('article', { launchId: launch.id, input, direct }, { title: `Writing the pieces for “${input.title}”`, launchId: launch.id });
    return job ? { ok: true, job } : { ok: false, problem: 'the article could not be queued' };
  });
}

/** Approving merges the pull request; publishing follows as a job */
export async function approve(launchId: number): Promise<Started> {
  // Approving merges a real pull request on the launches repo
  if (fakeNetworks()) return { ok: false, problem: PREVIEW_REFUSAL };
  let launch: Launch;
  try {
    launch = await (await launches()).approve(launchId);
  } catch (error) {
    // GitHub refusing the merge is the owner's to read, as a refusal is
    return { ok: false, problem: error instanceof Error ? error.message : String(error) };
  }
  return { ok: true, job: await startPublishing(launch) };
}

/** Queues (or moves) the wake-up of each scheduled piece at its time */
export async function armSchedule(posts: Post[]): Promise<void> {
  const { queue } = await appContext();
  for (const post of posts) await armScheduled(queue, post);
}
