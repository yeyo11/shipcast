import { draftArticle, draftLaunch, publishLaunch, UNFINISHED_JOB_STATES, type GitHubRest, type Launch, type PipelineDeps, type Registry } from '@shipcast/engine';
import type { Brand, Channel } from '@shipcast/schema';
import { LAST_ROUND_KEY, readAutomation, record } from './automation.ts';
import { PUBLISH_RETRIES, PUBLISH_RETRY_SECONDS, RetryLater, type Handlers, type WorkQueue } from './queue.ts';
import { notify, readMetrics, refreshInstagramTokens, runRound } from './rounds.ts';
import type { SecretStore } from './secrets.ts';
import { buildServices, type Services } from './services.ts';
import { claimFromWebhook, launchOfPullRequest } from './webhooks.ts';

/** What the jobs need: the engine's pieces, and the brand read when a job runs, not when it was sent */
export interface WorkDeps {
  env: NodeJS.ProcessEnv;
  registry: Registry;
  github: GitHubRest;
  secrets: SecretStore;
  pipeline: PipelineDeps;
  brand(): Promise<Brand>;
  /** The connectors for a brand; built from the keychain and `.env` unless a test gives its own */
  services?: (brand: Brand) => Promise<Services>;
}

/** The one key of the round queue: whichever process sends a round, there is one queued and one running at most */
export const ROUND_KEY = 'round';
/** A round sent by hand runs whatever the mode is, and always looks for releases */
export const BY_HAND = 'by hand';

/** Each launch has its own publish key, so two launches publish side by side but one never twice at once */
const publishKey = (launchId: number) => `launch:${launchId}`;

const nameOf = (launch: Launch) => `${launch.repo.split('/')[1] ?? launch.repo} ${launch.ref.replace(/^article:/, '')}`;
const pageOf = (launchId: number) => `/launches/${launchId}`;

/**
 * Queues the publishing of a drafted launch. A launch whose publishing is queued already keeps that
 * job, whose id comes back: asking twice never publishes twice.
 */
export async function startPublishing(queue: WorkQueue, launch: Launch, retryChannel?: Channel): Promise<string | undefined> {
  const title = retryChannel ? `Retrying ${retryChannel} for ${nameOf(launch)}` : `Publishing ${nameOf(launch)}`;
  const id = await queue.send('publish', { launchId: launch.id, ...(retryChannel && { retryChannel }) }, { title, launchId: launch.id, singletonKey: publishKey(launch.id) });
  if (id) return id;
  const [waiting] = await queue.registry.jobs({ launchId: launch.id, queues: ['publish'], states: UNFINISHED_JOB_STATES, limit: 1 });
  return waiting?.id;
}

export async function startDrafting(queue: WorkQueue, launch: Launch, direct = false): Promise<string | null> {
  return queue.send('draft', { launchId: launch.id, direct }, { title: `Drafting ${launch.repo} ${launch.ref}`, launchId: launch.id });
}

/**
 * Sends the next round, `inSeconds` from now. A round already queued is moved to that moment instead,
 * so "run a round now" and a changed interval never leave two waiting.
 */
export async function scheduleRound(queue: WorkQueue, reason: string, inSeconds = 0): Promise<string | null> {
  return queue.upsert('round', { reason }, { singletonKey: ROUND_KEY, startAfter: inSeconds, title: reason === BY_HAND ? 'Automation round, by hand' : 'Automation round' });
}

/** Whether a round is running now, in any process */
export async function roundRunning(registry: Registry): Promise<boolean> {
  return (await registry.jobs({ queues: ['round'], states: ['active'], limit: 1 })).length > 0;
}

/** The handlers of every queue; the app and `shipcast watch` run the same ones */
export function workHandlers(queue: WorkQueue, d: WorkDeps): Handlers {
  const { registry } = d;
  const servicesFor = d.services ?? ((brand: Brand) => buildServices({ env: d.env, brand, registry, github: d.github, secrets: d.secrets }));
  const launch = async (id: number) => {
    const found = await registry.get(id);
    if (!found) throw new Error(`no launch ${id}`);
    return found;
  };
  // Work nobody started by hand waits while automation is off; the same job sent by hand runs
  const off = async (reason: string) => reason !== BY_HAND && (await readAutomation(registry)).mode === 'off';

  return {
    async draft({ launchId, direct }, job) {
      const current = await launch(launchId);
      job.link(pageOf(launchId));
      if (current.status === 'drafted' || current.status === 'published' || current.status === 'skipped') {
        job.log(`Nothing to draft: the launch is ${current.status}`);
        return;
      }
      const brand = await d.brand();
      const services = await servicesFor(brand);
      job.log('Reading the code and writing the pack; this takes a few minutes…');
      const result = await draftLaunch(current, brand, d.pipeline, { direct: direct ?? false });
      if (!result.ok) {
        await notify(services, `Shipcast could not draft ${nameOf(current)}: ${result.problems[0] ?? ''}`);
        throw new Error(result.problems.join('\n'));
      }
      job.log(direct ? `Committed to main: ${result.pullRequest}` : `Drafts are waiting: ${result.pullRequest}`);
      if (direct) await startPublishing(queue, result.launch);
      else await notify(services, `Shipcast drafted ${nameOf(current)}: review the drafts at ${result.pullRequest}`);
    },

    async article({ launchId, input, direct }, job) {
      const current = await launch(launchId);
      job.link(pageOf(launchId));
      const brand = await d.brand();
      const services = await servicesFor(brand);
      job.log('Translating the article and writing each channel’s piece…');
      const result = await draftArticle(current, input, brand, d.pipeline, { direct: direct ?? false });
      if (!result.ok) throw new Error(result.problems.join('\n'));
      job.log(direct ? `Committed to main: ${result.pullRequest}` : `Drafts are waiting: ${result.pullRequest}`);
      if (direct) await startPublishing(queue, result.launch);
      else await notify(services, `Shipcast drafted the article “${input.title}”: review it at ${result.pullRequest}`);
    },

    /*
     * One try at publishing. The site must deploy before the channels can link to it: while it has
     * not, the job is tried again after PUBLISH_RETRY_SECONDS, PUBLISH_RETRIES times, instead of a
     * loop sleeping in one process that a restart would lose.
     */
    async publish({ launchId, retryChannel }, job) {
      let current = await launch(launchId);
      job.link(pageOf(launchId));
      if (retryChannel && job.attempt === 1) {
        // Only this launch's failure is forgotten; the channel stays failed for any other launch
        await registry.deleteCursor(`publish-failed:${launchId}:${retryChannel}`);
        if (current.status === 'published') current = await registry.setStatus(launchId, 'drafted', current.detail);
      }
      if (current.status !== 'drafted') {
        job.log(`Nothing to publish: the launch is ${current.status}`);
        return;
      }
      const brand = await d.brand();
      const services = await servicesFor(brand);
      const result = await publishLaunch(current, brand, {
        github: d.github,
        registry,
        launchesRepo: d.pipeline.launchesRepo,
        publishers: services.publishers,
        search: services.sources.search,
        accounts: services.accounts,
      });
      if (result.state === 'waiting') {
        const minutes = Math.round((PUBLISH_RETRIES * PUBLISH_RETRY_SECONDS) / 60);
        if (job.lastAttempt) throw new Error(`still waiting after ${minutes} minutes (${result.reason}); the next publish round will pick it up`);
        throw new RetryLater(result.reason);
      }
      if (result.state === 'skipped') {
        job.log('The pull request was closed without merging: nothing published');
        return;
      }
      for (const p of result.posted) job.log(`${p.channel}: ${p.url}`);
      for (const p of result.problems) job.log(p);
      const willRetry = result.state === 'partial' && result.problems.some((p) => p.includes('(will retry)'));
      // An attempt that only finds the same channels still failing tells the owner nothing new
      if (result.posted.length > 0 || !willRetry || job.lastAttempt) {
        await notify(
          services,
          result.state === 'published'
            ? `Shipcast published ${nameOf(current)}: ${result.posted.map((p) => p.channel).join(', ') || 'nothing new'}`
            : `Shipcast published ${nameOf(current)} in part. Problems: ${result.problems.join('; ')}`,
        );
      }
      if (willRetry && !job.lastAttempt) throw new RetryLater('some channels will try again');
    },

    /** A delivery's work: what GitHub announced is claimed and drafted, or a merged launch published */
    async delivery({ action }, job) {
      if (action.kind === 'claim') {
        const outcome = await claimFromWebhook({ github: d.github, registry, brand: await d.brand() }, action.event);
        if (outcome.result !== 'claimed') {
          job.log(outcome.result === 'ignored' ? `Ignored: ${outcome.reason}` : `Not claimed: ${outcome.result}`);
          return;
        }
        job.log(`Claimed ${outcome.launch.repo} ${outcome.launch.ref}: drafting`);
        job.link(pageOf(outcome.launch.id));
        await startDrafting(queue, outcome.launch);
        return;
      }
      const merged = await launchOfPullRequest({ registry }, action.pullRequestUrl);
      if (!merged) {
        job.log('A merge Shipcast has no drafted launch for');
        return;
      }
      job.log(`Publishing ${nameOf(merged)}`);
      job.link(pageOf(merged.id));
      await startPublishing(queue, merged);
    },

    /*
     * A round, then the next one, an interval later: the chain reads the settings at every link, so a
     * change in the Automation page counts from the next round. With automation off the chain stops;
     * saving the settings or starting a process sends a round again.
     */
    async round({ reason }, job) {
      const automation = await readAutomation(registry);
      if (automation.mode === 'off' && reason !== BY_HAND) {
        job.log('Automation is off: no round');
        return;
      }
      const lines: string[] = [];
      const log = (line: string) => {
        lines.push(line);
        job.log(line);
      };
      try {
        await runRound(
          { env: d.env, registry, github: d.github, secrets: d.secrets, brand: await d.brand(), pipeline: d.pipeline, log },
          {
            detect: automation.mode === 'poll' || reason === BY_HAND,
            draft: async (claimed) => {
              log(`Claimed ${claimed.repo} ${claimed.ref}: drafting`);
              await startDrafting(queue, claimed);
            },
            // A launch with its own publish job waiting for the deploy is left to that job
            busy: async (drafted) => (await registry.jobs({ launchId: drafted.id, queues: ['publish'], states: UNFINISHED_JOB_STATES, limit: 1 })).length > 0,
          },
        );
      } finally {
        await record(registry, LAST_ROUND_KEY, {
          at: new Date().toISOString(),
          summary: lines.length ? `${reason}: ${lines.length} things happened` : `${reason}: nothing to do`,
          lines,
        });
        const next = await readAutomation(registry);
        if (next.mode !== 'off') {
          // A plain send: a round already queued (sent by hand while this one ran) is the next one
          await queue.send('round', { reason: next.mode === 'poll' ? 'polling' : 'maintenance' }, { singletonKey: ROUND_KEY, startAfter: next.intervalSeconds, title: 'Automation round' });
        }
        // The rows of finished jobs are kept a fortnight; the round is what keeps them from growing
        await registry.pruneJobs(new Date(Date.now() - 14 * 86_400_000).toISOString());
      }
    },

    async metrics({ reason }, job) {
      if (await off(reason)) {
        job.log('Automation is off: the numbers are read by hand');
        return;
      }
      const brand = await d.brand();
      for (const line of await readMetrics({ registry, brand }, await servicesFor(brand))) job.log(line);
    },

    async 'instagram-tokens'({ reason }, job) {
      if (await off(reason)) {
        job.log('Automation is off: no token refreshed');
        return;
      }
      const lines = await refreshInstagramTokens(d, await servicesFor(await d.brand()));
      for (const line of lines) job.log(line);
      if (lines.length === 0) job.log('No token is due');
    },
  };
}

/** When the scheduled jobs are sent, in UTC: the numbers every six hours, the tokens once a day */
export const METRICS_CRON = '0 */6 * * *';
export const TOKENS_CRON = '30 3 * * *';
/** A round every ten minutes at most if the chain of rounds broke (a crash between two links) */
export const ROUND_WATCHDOG_CRON = '*/10 * * * *';

/**
 * Makes this process a worker of every queue: the handlers, the schedules, and a first round soon
 * after start (the round already queued, if any, is moved to then), so a restart never waits a
 * whole interval.
 */
export async function startWorking(queue: WorkQueue, d: WorkDeps, options: { firstRoundInSeconds?: number } = {}): Promise<void> {
  await queue.work(workHandlers(queue, d));
  await queue.schedule('metrics', METRICS_CRON, { reason: 'every 6 hours' });
  await queue.schedule('instagram-tokens', TOKENS_CRON, { reason: 'daily' });
  // The round's key: a watchdog round is dropped while the chain has one queued
  await queue.schedule('round', ROUND_WATCHDOG_CRON, { reason: 'watchdog' }, { singletonKey: ROUND_KEY });
  if ((await readAutomation(d.registry)).mode !== 'off') await scheduleRound(queue, 'after a start', options.firstRoundInSeconds ?? 15);
}
