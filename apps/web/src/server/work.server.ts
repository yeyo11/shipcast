import {
  approveLaunch,
  claimArticle,
  claimManual,
  draftArticle,
  draftLaunch,
  preflight,
  publishLaunch,
  type ArticleInput,
  type Launch,
} from '@shipcast/engine';
import { buildServices, type Services } from '@shipcast/runtime';
import { appContext } from './context.server';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function services(): Promise<Services> {
  const { registry, github, secrets, brand } = await appContext();
  return buildServices({ env: process.env, brand: await brand(), registry, github, secrets });
}

/** Tells the owner through Telegram, when it is connected; a failed notice never fails the work */
async function notify(text: string): Promise<void> {
  const s = await services().catch(() => undefined);
  await s?.notifier?.notify(text).catch(() => undefined);
}

/**
 * Publishes a launch once its drafts are on main: the site must deploy before the channels can link
 * to it, so this waits, trying every 30 seconds for up to 20 minutes, like a watch round would.
 */
export async function startPublishing(launch: Launch): Promise<string> {
  const { jobs, registry, deps, brand } = await appContext();
  const name = `${launch.repo.split('/')[1]} ${launch.ref.replace(/^article:/, '')}`;
  return jobs.start(`Publishing ${name}`, async (log) => {
    const deadline = Date.now() + 20 * 60_000;
    for (;;) {
      const current = (await registry.get(launch.id))!;
      const { publishers, sources, accounts } = await services();
      const result = await publishLaunch(current, await brand(), { github: deps.github, registry, launchesRepo: deps.launchesRepo, publishers, search: sources.search, accounts });
      if (result.state === 'waiting') {
        log(`Waiting: ${result.reason}`);
        if (Date.now() > deadline) throw new Error(`still waiting after 20 minutes (${result.reason}); the next publish round will pick it up`);
        await sleep(30_000);
        continue;
      }
      if (result.state === 'skipped') {
        log('The pull request was closed without merging: nothing published');
        return `/launches/${launch.id}`;
      }
      for (const p of result.posted) log(`${p.channel}: ${p.url}`);
      for (const p of result.problems) log(p);
      await notify(
        result.state === 'published'
          ? `Shipcast published ${name}: ${result.posted.map((p) => p.channel).join(', ') || 'nothing new'}`
          : `Shipcast published ${name} in part. Problems: ${result.problems.join('; ')}`,
      );
      if (result.state === 'partial' && result.problems.some((p) => p.includes('(will retry)'))) {
        if (Date.now() > deadline) return `/launches/${launch.id}`;
        await sleep(60_000);
        continue;
      }
      return `/launches/${launch.id}`;
    }
  }).id;
}

/** Drafts a repo's launch after its pre-flight passes; publishing directly goes on to publish */
export async function startLaunch(repo: string, ref: string | undefined, direct: boolean): Promise<{ ok: true; job: string } | { ok: false; problem: string }> {
  const { jobs, deps, github, brand } = await appContext();
  const check = await preflight(repo, ref, { github });
  if (!check.ok) return { ok: false, problem: check.checks.filter((c) => !c.ok && c.required).map((c) => c.detail).join(' ') };
  const b = await brand();
  const claim = await claimManual(repo, ref, b, deps);
  if ('error' in claim) return { ok: false, problem: claim.error };
  if (!claim.claimed) return { ok: false, problem: `${repo} ${claim.launch.ref} was launched already (${claim.launch.status}).` };
  const job = jobs.start(`Drafting ${repo} ${claim.launch.ref}`, async (log, self) => {
    log('Reading the code and writing the pack; this takes a few minutes…');
    const result = await draftLaunch(claim.launch, b, deps, { direct });
    if (!result.ok) throw new Error(result.problems.join('\n'));
    log(direct ? `Committed to main: ${result.pullRequest}` : `Drafts are waiting: ${result.pullRequest}`);
    if (result.costUsd !== null) log(`AI cost: $${result.costUsd.toFixed(2)}`);
    if (direct) await startPublishing(result.launch);
    else await notify(`Shipcast drafted ${repo} ${claim.launch.ref}: review the drafts at ${result.pullRequest}`);
    self.link = `/launches/${claim.launch.id}`;
    return self.link;
  });
  return { ok: true, job: job.id };
}

/** Drafts an article written in the app; publishing directly goes on to publish */
export async function startArticle(input: ArticleInput, direct: boolean): Promise<{ ok: true; job: string } | { ok: false; problem: string }> {
  const { jobs, deps, brand } = await appContext();
  const b = await brand();
  const claim = await claimArticle(input, b, deps);
  if (!claim.claimed && claim.launch.status !== 'failed') return { ok: false, problem: `An article titled like this exists already (${claim.launch.status}). Change the title.` };
  const job = jobs.start(`Writing the pieces for “${input.title}”`, async (log, self) => {
    log('Translating the article and writing each channel’s piece…');
    const result = await draftArticle(claim.launch, input, b, deps, { direct });
    if (!result.ok) throw new Error(result.problems.join('\n'));
    log(direct ? `Committed to main: ${result.pullRequest}` : `Drafts are waiting: ${result.pullRequest}`);
    if (direct) await startPublishing(result.launch);
    else await notify(`Shipcast drafted the article “${input.title}”: review it at ${result.pullRequest}`);
    self.link = `/launches/${claim.launch.id}`;
    return self.link;
  });
  return { ok: true, job: job.id };
}

/** Approving merges the pull request; publishing follows in the background */
export async function approve(launchId: number): Promise<{ ok: true; job: string } | { ok: false; problem: string }> {
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
