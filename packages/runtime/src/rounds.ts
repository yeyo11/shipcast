import { detect, draftLaunch, MetricsService, NotificationService, publishLaunch, type GitHubRest, type HourlyOptions, type PublishingService, type Launch, type PipelineDeps, type PublishResult, type Repositories } from '@shipcast/engine';
import type { Brand } from '@shipcast/schema';
import { network, NETWORK_SPECS, networkSpec } from './catalog.ts';
import { getJson, type SecretStore } from './secrets.ts';
import { accountSecretKey, buildServices, publishConnectors, refreshInstagramToken, type Services } from './services.ts';

// Where the engine's MetricsService writes; re-exported for the pages that show it
export { METRICS_AT_KEY } from '@shipcast/engine';

/** What a round needs: the engine's pieces and the brand it speaks for */
export interface RoundDeps {
  env: NodeJS.ProcessEnv;
  registry: Pick<Repositories, 'launches' | 'posts' | 'metrics' | 'accounts' | 'cursors'>;
  github: GitHubRest;
  secrets: SecretStore;
  brand: Brand;
  pipeline: PipelineDeps;
  /** Each thing worth saying, as it happens */
  log?: (line: string) => void;
  /** With the publishing-service flag: every publish through it, under this holder's claims */
  publishing?: { service: PublishingService; holder: string };
  /**
   * The services the round publishes and notifies with, when the process builds its own (a preview's,
   * whose networks are fake); otherwise the brand's, built from its credentials
   */
  services?: (brand: Brand) => Promise<Services>;
}

/** The owner's notices through the brand's Telegram, when it is connected (the engine's NotificationService) */
export const notifications = (services: Pick<Services, 'notifier'>) => new NotificationService(services.notifier);

/** A line to the owner's Telegram, when it is connected; a failed notice never stops the round */
export async function notify(services: Services, text: string): Promise<void> {
  await notifications(services).say(text);
}

const name = (launch: Launch) => `${launch.repo} ${launch.ref.replace(/^article:/, '')}`;

/** Drafts a launch that was just claimed, and tells the owner where its drafts are */
export async function draftClaimed(launch: Launch, d: RoundDeps, services: Services): Promise<void> {
  const log = d.log ?? (() => {});
  const result = await draftLaunch(launch, d.brand, d.pipeline);
  if (result.ok) log(`Drafted ${name(launch)}: ${result.pullRequest}`);
  else log(`Could not draft ${name(launch)}: ${result.problems.join('; ')}`);
  await notifications(services).drafted(launch, result);
}

/** Publishes one drafted launch if it is ready, and tells the owner what went out */
export async function publishOne(launch: Launch, d: RoundDeps, services: Services): Promise<PublishResult> {
  const log = d.log ?? (() => {});
  const connectors = publishConnectors(services);
  const result = d.publishing
    ? await d.publishing.service.publish(launch, d.brand, connectors, d.publishing.holder)
    : await publishLaunch(launch, d.brand, { github: d.github, registry: d.registry, launchesRepo: d.pipeline.launchesRepo, ...connectors, ...(d.pipeline.launchStore && { launchStore: d.pipeline.launchStore }), ...(d.pipeline.appReview && { appReview: d.pipeline.appReview }) });
  if (result.state === 'published' || result.state === 'partial') {
    for (const p of result.posted) log(`${name(launch)} on ${p.channel}: ${p.url}`);
    for (const p of result.problems) log(`${name(launch)}: ${p}`);
  }
  // A round is final for its run: the next round is a new run, not this one's retry
  await notifications(services).published(launch, result, { final: true });
  return result;
}

/**
 * Refreshes every connected account's token of the network that is due (its spec's `refresh`: Meta's
 * last 60 days and are refreshed at 30), keeping the fresh one in its keychain entry. Meta refuses
 * to refresh a token younger than a day, so an account seen for the first time only records the date.
 */
export async function refreshMetaAccounts(networkId: string, d: Pick<RoundDeps, 'registry' | 'secrets'>, now = new Date(), http?: typeof fetch): Promise<string[]> {
  const refresh = networkSpec(networkId)?.refresh;
  if (!refresh) return [];
  const name = network(networkId)?.name ?? networkId;
  const lines: string[] = [];
  for (const account of await d.registry.accounts.accounts({ network: networkId })) {
    const remember = () => d.registry.accounts.updateAccount(account.id, { settings: { ...account.settings, refreshedAt: now.toISOString() } });
    const last = account.settings.refreshedAt;
    if (!last) {
      await remember();
      continue;
    }
    if (now.getTime() - Date.parse(last) < refresh.everyMs) continue;
    const secrets = await getJson(d.secrets, accountSecretKey(account.id));
    const refresher = secrets?.accessToken ? refresh.refresher(account.settings, secrets.accessToken, http) : undefined;
    if (!secrets || !refresher) continue;
    try {
      const fresh = await refresher.refreshToken();
      await d.secrets.set(accountSecretKey(account.id), JSON.stringify({ ...secrets, accessToken: fresh.accessToken }), `${networkId} ${account.label}`);
      await remember();
      lines.push(`${name} token of ${account.label} refreshed; valid for ${Math.round(fresh.expiresIn / 86400)} more days`);
    } catch (error) {
      lines.push(`${name} token of ${account.label} not refreshed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return lines;
}

/** Every connected Instagram account's token that is due */
export function refreshInstagramAccounts(d: Pick<RoundDeps, 'registry' | 'secrets'>, now = new Date(), http?: typeof fetch): Promise<string[]> {
  return refreshMetaAccounts('instagram', d, now, http);
}

async function step(name: string, log: (line: string) => void, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    // One step failing never keeps the others from running this round
    log(`${name} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export interface RoundOptions {
  detect: boolean;
  /** What happens to a release the round claimed; by default it is drafted here, which takes minutes */
  draft?: (launch: Launch, services: Services) => Promise<void>;
  /** Whether other work is publishing a launch already, which the round then leaves to it */
  busy?: (launch: Launch) => Promise<boolean>;
  /**
   * With the publishing-service flag the round publishes nothing itself: it hands each drafted launch
   * to this (which queues its publish job), so a launch is only ever published by its own job
   */
  enqueue?: (launch: Launch) => Promise<void>;
}

/**
 * One round of the work nobody has to start by hand: claim the account's new releases (when polling;
 * webhooks claim them as they happen) and publish every drafted launch that is ready. The queue's
 * round job runs it, in the app or in `shipcast watch`; reading the metrics and refreshing the
 * Instagram tokens are jobs of their own, on schedules.
 */
export async function runRound(d: RoundDeps, options: RoundOptions): Promise<void> {
  const log = d.log ?? (() => {});
  const services = d.services ? await d.services(d.brand) : await buildServices({ env: d.env, brand: d.brand, registry: d.registry, github: d.github, secrets: d.secrets });
  const draft = options.draft ?? ((launch: Launch, s: Services) => draftClaimed(launch, d, s));

  if (options.detect) {
    await step('detect', log, async () => {
      for (const outcome of await detect({ github: d.github, registry: d.registry, brand: d.brand })) {
        if (outcome.result === 'claimed') await draft(outcome.launch, services);
        else if (outcome.result === 'invalid-config') log(`${outcome.event.repo}: ${outcome.launch.detail}`);
      }
    });
  }
  await step('publish', log, async () => {
    for (const launch of (await d.registry.launches.recent(100)).filter((l) => l.status === 'drafted')) {
      if (options.enqueue) {
        await options.enqueue(launch);
        continue;
      }
      if (await options.busy?.(launch)) continue;
      await publishOne(launch, d, services);
    }
  });
}

/** Every Instagram and Threads token that is due: the connected accounts', and an Instagram one still read from `.env` */
export async function refreshInstagramTokens(d: Pick<RoundDeps, 'registry' | 'secrets'>, services: Services, now = new Date(), http?: typeof fetch): Promise<string[]> {
  // Every network whose tokens are refreshed, as their specs say (Instagram's and Threads')
  const lines: string[] = [];
  for (const spec of NETWORK_SPECS) if (spec.refresh) lines.push(...(await refreshMetaAccounts(spec.id, d, now, http)));
  // A token still read from .env is refreshed where it lives, in the registry
  if (services.instagram?.origin.kind === 'env') {
    const line = await refreshInstagramToken(services, d, now);
    if (line) lines.push(line);
  }
  return lines;
}

/** The hourly reads (the `batched-metrics` flag): each source at its own cadence, batched, unchanged values only checked */
export async function readMetricsHourly(d: Pick<RoundDeps, 'registry' | 'brand'>, services: Services, now = new Date(), options: HourlyOptions = {}): Promise<string[]> {
  const result = await new MetricsService(d.registry).readHourly(d.brand, services.sources, now, options);
  return [`Metrics: ${result.readings} readings`, ...result.problems.map((p) => `  ${p}`)];
}

/** Reads every published launch's numbers now, and remembers when */
export async function readMetrics(d: Pick<RoundDeps, 'registry' | 'brand'>, services: Services, now = new Date()): Promise<string[]> {
  const result = await new MetricsService(d.registry).readNow(d.brand, services.sources, now);
  return [`Metrics: ${result.readings} readings`, ...result.problems.map((p) => `  ${p}`)];
}
