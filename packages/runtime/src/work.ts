import { draftArticle, draftLaunch, draftReply, publishLaunch, PublishingService, runChecks, runComments, TelemetryStore, UNFINISHED_JOB_STATES, type Account, type GitHubRest, type Launch, type PipelineDeps, type Post, type Repositories } from '@shipcast/engine';
import { pullRequestNumber, type Brand, type Channel } from '@shipcast/schema';
import { LAST_ROUND_KEY, readAutomation, record } from './automation.ts';
import { Flags } from './flags.ts';
import { PUBLISH_RETRIES, PUBLISH_RETRY_SECONDS, RetryLater, type Handlers, type JobQueue, type WorkQueue } from './queue.ts';
import { notifications, notify, readMetrics, refreshInstagramTokens, runRound } from './rounds.ts';
import type { SecretStore } from './secrets.ts';
import { SettingMissing } from './settings.ts';
import { buildServices, type Services } from './services.ts';
import { takeSnapshots } from './snapshots.ts';
import { claimFromWebhook, launchOfPullRequest } from './webhooks.ts';
import { COMMENTS_CRON, COMMENTS_KEY, commentsNotice, replyDeps } from './comments.ts';
import { runProfileReview } from './profiles.ts';

/** What the jobs need: the engine's pieces, and the brand read when a job runs, not when it was sent */
export interface WorkDeps {
  env: NodeJS.ProcessEnv;
  registry: Repositories;
  github: GitHubRest;
  secrets: SecretStore;
  pipeline: PipelineDeps;
  brand(): Promise<Brand>;
  /** The connectors for a brand; built from the keychain and `.env` unless a test gives its own */
  services?: (brand: Brand) => Promise<Services>;
  /** What the accounts' syncs reach the networks with; fetch unless a test gives its own */
  fetch?: typeof fetch;
  /** Reads the settings again, before each round, so a change made in the app reaches every worker */
  refresh?: () => Promise<void>;
  /** The refactor's switches; all off when not given */
  flags?: Flags;
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
  const [waiting] = await queue.registry.jobs.jobs({ launchId: launch.id, queues: ['publish'], states: UNFINISHED_JOB_STATES, limit: 1 });
  return waiting?.id;
}

/** The key of a scheduled piece's wake-up: one queued per piece, moved when the piece is */
const scheduledKey = (postId: number) => `post:${postId}`;

/**
 * Queues the wake-up of a scheduled piece at its time, or moves the one queued already. A time past
 * (a slot missed while the machine was off) wakes it at once. Idempotent: arming a piece twice
 * leaves one job, and the job does nothing if the piece went out or moved meanwhile.
 */
export async function armScheduled(queue: JobQueue, post: Post, launch?: Launch): Promise<string | null> {
  if (post.status !== 'scheduled' || !post.scheduledAt) return null;
  const at = new Date(Math.max(Date.parse(post.scheduledAt), Date.now()));
  const of = launch ? ` of ${nameOf(launch)}` : '';
  return queue.upsert('scheduled', { postId: post.id, launchId: post.launchId }, { singletonKey: scheduledKey(post.id), startAfter: at, title: `${post.channel}${of} at ${post.scheduledAt.slice(0, 16).replace('T', ' ')} UTC`, launchId: post.launchId });
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
export async function roundRunning(registry: Pick<Repositories, 'jobs'>): Promise<boolean> {
  return (await registry.jobs.jobs({ queues: ['round'], states: ['active'], limit: 1 })).length > 0;
}

/** The handlers of every queue; the app and `shipcast watch` run the same ones */
export function workHandlers(queue: WorkQueue, d: WorkDeps): Handlers {
  const { registry } = d;
  const flags = d.flags ?? new Flags();
  const publishing = new PublishingService({ registry, github: d.github, launchesRepo: d.pipeline.launchesRepo });
  const servicesFor = d.services ?? ((brand: Brand) => buildServices({ env: d.env, brand, registry, github: d.github, secrets: d.secrets }));
  const launch = async (id: number) => {
    const found = await registry.launches.get(id);
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
        await notifications(services).drafted(current, result);
        throw new Error(result.problems.join('\n'));
      }
      job.log(direct ? `Committed to main: ${result.pullRequest}` : `Drafts are waiting: ${result.pullRequest}`);
      // Straight to publishing: the publish run tells the owner what went out
      if (direct) await startPublishing(queue, result.launch);
      else await notifications(services).drafted(current, result);
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
      else await notifications(services).drafted(current, result, { article: input.title });
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
        current = (await publishing.retry(launchId, retryChannel)) ?? current;
      }
      if (current.status !== 'drafted') {
        job.log(`Nothing to publish: the launch is ${current.status}`);
        return;
      }
      const brand = await d.brand();
      const services = await servicesFor(brand);
      const connectors = { publishers: services.publishers, search: services.sources.search, accounts: services.accounts };
      const result = flags.on('publishing-service')
        ? await publishing.publish(current, brand, connectors, job.id)
        : await publishLaunch(current, brand, { github: d.github, registry, launchesRepo: d.pipeline.launchesRepo, ...connectors });
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
      for (const p of result.scheduled) job.log(`${p.channel}: scheduled for ${p.at}`);
      // One rule for what the owner is told, the round's too: quiet while only retryable failures wait for the next attempt
      await notifications(services).published(current, result, { final: job.lastAttempt });
      const willRetry = result.state === 'partial' && result.failures.some((f) => f.retryable);
      if (willRetry && !job.lastAttempt) throw new RetryLater('some channels will try again');
    },

    /*
     * A scheduled piece's time has come: the launch's publishing is queued, and the publish step
     * sends what is due. The post row is the truth, so a job for a piece cancelled, moved later or
     * already out does nothing; a launch whose drafts still wait for approval waits, and its merge
     * publishes what is overdue by then.
     */
    async scheduled({ postId, launchId }, job) {
      job.link(pageOf(launchId));
      const post = await registry.posts.post(postId);
      if (!post || post.status !== 'scheduled') {
        job.log('Nothing to do: the post is no longer scheduled');
        return;
      }
      if (post.scheduledAt && Date.parse(post.scheduledAt) > Date.now()) {
        // Moved later after this job was queued; the job keeps its key, so arming it again moves it
        job.log(`Moved to ${post.scheduledAt}`);
        await armScheduled(queue, post);
        return;
      }
      const current = await launch(launchId);
      if (current.status !== 'drafted') {
        job.log(`Waiting: the launch is ${current.status}; its publishing sends what is due`);
        return;
      }
      const number = pullRequestNumber(current);
      if (number && (await d.github.pullRequestState(d.pipeline.launchesRepo, number)) === 'open') {
        job.log('Waiting for approval: it goes out once the drafts are merged');
        return;
      }
      job.log(`${post.channel} is due: publishing ${nameOf(current)}`);
      await startPublishing(queue, current);
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
      await d.refresh?.();
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
        let brand: Brand;
        try {
          brand = await d.brand();
        } catch (error) {
          // Nothing to watch or publish yet: the round says why and the chain goes on, so it starts once the setting is saved
          if (!(error instanceof SettingMissing)) throw error;
          log(error.message);
          return;
        }
        await runRound(
          { env: d.env, registry, github: d.github, secrets: d.secrets, brand, pipeline: d.pipeline, log },
          {
            detect: automation.mode === 'poll' || reason === BY_HAND,
            draft: async (claimed) => {
              log(`Claimed ${claimed.repo} ${claimed.ref}: drafting`);
              await startDrafting(queue, claimed);
            },
            // With the publishing service the round only queues: a launch is published by its own job, one at a time
            ...(flags.on('publishing-service') && {
              enqueue: async (drafted: Launch) => {
                if ((await publishing.approval(drafted)).state !== 'waiting') await startPublishing(queue, drafted);
              },
            }),
            // A launch with its own publish job waiting for the deploy is left to that job
            busy: async (drafted) => (await registry.jobs.jobs({ launchId: drafted.id, queues: ['publish'], states: UNFINISHED_JOB_STATES, limit: 1 })).length > 0,
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
        await registry.jobs.pruneJobs(new Date(Date.now() - 14 * 86_400_000).toISOString());
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

    async snapshots({ reason, accountId }, job) {
      if (await off(reason)) {
        job.log('Automation is off: the accounts are synced by hand');
        return;
      }
      const brand = await d.brand();
      const results = await takeSnapshots(
        { registry, secrets: d.secrets, brands: new Map([[brand.id, brand]]), ...(d.fetch && { fetch: d.fetch }) },
        accountId === undefined ? {} : { accountId },
      );
      for (const result of results) job.log(result.line);
      if (results.length === 0) job.log('No account is connected');
      if (accountId !== undefined) job.link('/channels');
      const failed = results.filter((r) => r.outcome === 'failed').length;
      // A Sync now that failed says so on the job; the daily run fails only when nothing at all could be read
      if (failed > 0 && (accountId !== undefined || failed === results.length)) throw new Error(`${failed} of ${results.length} could not be synced`);
    },

    /*
     * The comment assistant: every live post's comments read, the new ones drafted, the drafts of an
     * auto channel sent, and the owner told what waits; or, with a comment id, that one drafted again.
     */
    async comments({ reason, commentId }, job) {
      job.link('/comments');
      if (commentId === undefined && (await off(reason))) {
        job.log('Automation is off: the comments are read by hand');
        return;
      }
      const brand = await d.brand();
      const deps = replyDeps({ env: d.env, registry, secrets: d.secrets, pipeline: d.pipeline, brand, github: d.github, ...(d.fetch && { fetch: d.fetch }) });
      if (commentId !== undefined) {
        const drafted = await draftReply(commentId, deps);
        if (drafted.status === 'failed') throw new Error(drafted.problem ?? 'could not draft');
        job.log(drafted.draft ? `Drafted: ${drafted.draft}` : `Suggested: dismiss (${drafted.classification ?? 'no reply'})`);
        return;
      }
      const result = await runComments(deps, { log: (line) => job.log(line) });
      if (result.drafted.length > 0) job.log(`Drafted ${result.drafted.length}; sent ${result.sent.length}`);
      const notice = commentsNotice(result, d.env.SHIPCAST_PUBLIC_URL);
      if (notice) await notify(await servicesFor(brand), notice);
      // A run that could read nothing at all failed; one network failing is in the log
      if (result.posts === 0 && result.problems.length > 0) throw new Error(result.problems.join('; '));
    },

    /** The measurement's checks (docs/plans/performance-refactor.md), from the registry only: no provider is called */
    async checks(_data, job) {
      for (const result of await runChecks(registry, new TelemetryStore(registry.database), { cadenceHours: METRICS_CADENCE_HOURS })) {
        job.log(`${result.name}: ${result.ok ? 'ok' : 'NOT OK'} (${Math.round(result.value * 1000) / 1000})`);
      }
    },

    /** An account's profile reviewed by the AI, sent by hand only; it changes nothing on the network */
    async 'profile-review'(request, job) {
      const account = await registry.accounts.account(request.accountId);
      if (account) job.link(`/channels/${account.network}?review=${account.id}`);
      const brand = await d.brand();
      await runProfileReview({ registry, secrets: d.secrets, pipeline: d.pipeline, brand, ...(d.fetch && { fetch: d.fetch }) }, request, (line) => job.log(line));
    },
  };
}

/** The key of one account's Sync now: a second click while one is queued is the same job */
const syncKey = (accountId: number) => `account:${accountId}`;

/**
 * Queues the sync of one account: its check, then its numbers. The job already queued for that
 * account, if any, is the one that answers, so clicking twice never syncs twice.
 */
export async function syncNow(queue: WorkQueue, account: Pick<Account, 'id' | 'label'>): Promise<string | undefined> {
  const id = await queue.send('snapshots', { reason: BY_HAND, accountId: account.id }, { title: `Syncing ${account.label}`, singletonKey: syncKey(account.id) });
  if (id) return id;
  const [waiting] = await queue.queued('snapshots', syncKey(account.id));
  return waiting;
}

/** When the scheduled jobs are sent, in UTC: the numbers every six hours, the tokens and the accounts once a day */
export const METRICS_CRON = '0 */6 * * *';
/** The hours between two runs of METRICS_CRON: how old a reading may be and still be fresh */
export const METRICS_CADENCE_HOURS = 6;
export const TOKENS_CRON = '30 3 * * *';
// After the token refresh, so an Instagram token renewed that night is the one that reads
export const SNAPSHOTS_CRON = '0 4 * * *';
/** A round every ten minutes at most if the chain of rounds broke (a crash between two links) */
export const ROUND_WATCHDOG_CRON = '*/10 * * * *';
/** The measurement's checks and page timings, hourly, off the round's minutes */
export const CHECKS_CRON = '7 * * * *';
export const PROBE_CRON = '37 * * * *';

/**
 * Makes this process a worker of every queue: the handlers, the schedules, and a first round soon
 * after start (the round already queued, if any, is moved to then), so a restart never waits a
 * whole interval.
 */
export async function startWorking(queue: WorkQueue, d: WorkDeps, options: { firstRoundInSeconds?: number; handlers?: Pick<Handlers, 'probe'> } = {}): Promise<void> {
  await queue.work({ ...workHandlers(queue, d), ...options.handlers });
  await queue.schedule('checks', CHECKS_CRON, { reason: 'hourly' });
  // Only a process that can load the pages (the web app) times them
  if (options.handlers?.probe) await queue.schedule('probe', PROBE_CRON, { reason: 'hourly' });
  await queue.schedule('metrics', METRICS_CRON, { reason: 'every 6 hours' });
  await queue.schedule('instagram-tokens', TOKENS_CRON, { reason: 'daily' });
  await queue.schedule('snapshots', SNAPSHOTS_CRON, { reason: 'daily' });
  await queue.schedule('comments', COMMENTS_CRON, { reason: 'every 30 minutes' }, { singletonKey: COMMENTS_KEY });
  // The round's key: a watchdog round is dropped while the chain has one queued
  await queue.schedule('round', ROUND_WATCHDOG_CRON, { reason: 'watchdog' }, { singletonKey: ROUND_KEY });
  if ((await readAutomation(d.registry)).mode !== 'off') await scheduleRound(queue, 'after a start', options.firstRoundInSeconds ?? 15);
  // Every scheduled piece has its wake-up queued; one missing (or one whose time passed while the machine was off) is armed now
  for (const post of await d.registry.posts.scheduledPosts()) await armScheduled(queue, post);
}
