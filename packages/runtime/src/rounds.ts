import { Instagram, Threads } from '@shipcast/connectors';
import { collectMetrics, detect, draftLaunch, publishLaunch, type GitHubRest, type PublishingService, type Launch, type PipelineDeps, type PublishResult, type Registry } from '@shipcast/engine';
import type { Brand } from '@shipcast/schema';
import { getJson, type SecretStore } from './secrets.ts';
import { accountSecretKey, buildServices, refreshInstagramToken, type Services } from './services.ts';

export const METRICS_AT_KEY = 'metrics-collected-at';
const TOKEN_REFRESH_EVERY_MS = 30 * 24 * 3600 * 1000;

/** What a round needs: the engine's pieces and the brand it speaks for */
export interface RoundDeps {
  env: NodeJS.ProcessEnv;
  registry: Registry;
  github: GitHubRest;
  secrets: SecretStore;
  brand: Brand;
  pipeline: PipelineDeps;
  /** Each thing worth saying, as it happens */
  log?: (line: string) => void;
  /** With the publishing-service flag: every publish through it, under this holder's claims */
  publishing?: { service: PublishingService; holder: string };
}

/** A line to the owner's Telegram, when it is connected; a failed notice never stops the round */
export async function notify(services: Services, text: string): Promise<void> {
  await services.notifier?.notify(text).catch(() => undefined);
}

const name = (launch: Launch) => `${launch.repo} ${launch.ref.replace(/^article:/, '')}`;

/** Drafts a launch that was just claimed, and tells the owner where its drafts are */
export async function draftClaimed(launch: Launch, d: RoundDeps, services: Services): Promise<void> {
  const log = d.log ?? (() => {});
  const result = await draftLaunch(launch, d.brand, d.pipeline);
  if (result.ok) {
    log(`Drafted ${name(launch)}: ${result.pullRequest}`);
    await notify(services, `Shipcast drafted ${name(launch)}: ${result.pullRequest}`);
  } else {
    log(`Could not draft ${name(launch)}: ${result.problems.join('; ')}`);
    await notify(services, `Shipcast could not draft ${name(launch)}: ${result.problems[0] ?? ''}`);
  }
}

/** Publishes one drafted launch if it is ready, and tells the owner what went out */
export async function publishOne(launch: Launch, d: RoundDeps, services: Services): Promise<PublishResult> {
  const log = d.log ?? (() => {});
  const connectors = { publishers: services.publishers, search: services.sources.search, accounts: services.accounts };
  const result = d.publishing
    ? await d.publishing.service.publish(launch, d.brand, connectors, d.publishing.holder)
    : await publishLaunch(launch, d.brand, { github: d.github, registry: d.registry, launchesRepo: d.pipeline.launchesRepo, ...connectors });
  if ((result.state === 'published' || result.state === 'partial') && (result.posted.length > 0 || result.problems.length > 0)) {
    for (const p of result.posted) log(`${name(launch)} on ${p.channel}: ${p.url}`);
    for (const p of result.problems) log(`${name(launch)}: ${p}`);
    await notify(
      services,
      result.problems.length > 0
        ? `Shipcast published ${name(launch)} in part: ${result.problems.join('; ')}`
        : `Shipcast published ${name(launch)}: ${result.posted.map((p) => p.url).join(' ')}`,
    );
  }
  return result;
}

/** The networks whose long-lived tokens last 60 days and are refreshed every 30: Meta's two */
type Refreshable = 'instagram' | 'threads';

function refresher(network: Refreshable, settings: Record<string, string>, accessToken: string, http?: typeof fetch): { refreshToken(): Promise<{ accessToken: string; expiresIn: number }> } {
  return network === 'instagram' ? new Instagram({ userId: settings.userId!, accessToken, fetch: http }) : new Threads({ userId: settings.userId!, accessToken, fetch: http });
}

/**
 * Refreshes every connected account's token of the network that is 30 days old (they last 60),
 * keeping the fresh one in its keychain entry. Meta refuses to refresh a token younger than a day,
 * so an account seen for the first time only records the date.
 */
export async function refreshMetaAccounts(network: Refreshable, d: Pick<RoundDeps, 'registry' | 'secrets'>, now = new Date(), http?: typeof fetch): Promise<string[]> {
  const name = network === 'instagram' ? 'Instagram' : 'Threads';
  const lines: string[] = [];
  for (const account of await d.registry.accounts({ network })) {
    const remember = () => d.registry.updateAccount(account.id, { settings: { ...account.settings, refreshedAt: now.toISOString() } });
    const last = account.settings.refreshedAt;
    if (!last) {
      await remember();
      continue;
    }
    if (now.getTime() - Date.parse(last) < TOKEN_REFRESH_EVERY_MS) continue;
    const secrets = await getJson(d.secrets, accountSecretKey(account.id));
    if (!secrets?.accessToken || !account.settings.userId) continue;
    try {
      const fresh = await refresher(network, account.settings, secrets.accessToken, http).refreshToken();
      await d.secrets.set(accountSecretKey(account.id), JSON.stringify({ ...secrets, accessToken: fresh.accessToken }), `${network} ${account.label}`);
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
  const services = await buildServices({ env: d.env, brand: d.brand, registry: d.registry, github: d.github, secrets: d.secrets });
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
    for (const launch of (await d.registry.recent(100)).filter((l) => l.status === 'drafted')) {
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
export async function refreshInstagramTokens(d: Pick<RoundDeps, 'registry' | 'secrets'>, services: Services, now = new Date()): Promise<string[]> {
  const lines = [...(await refreshInstagramAccounts(d, now)), ...(await refreshMetaAccounts('threads', d, now))];
  // A token still read from .env is refreshed where it lives, in the registry
  if (services.instagram?.origin.kind === 'env') {
    const line = await refreshInstagramToken(services, d, now);
    if (line) lines.push(line);
  }
  return lines;
}

/** Reads every published launch's numbers now, and remembers when */
export async function readMetrics(d: Pick<RoundDeps, 'registry' | 'brand'>, services: Services, now = new Date()): Promise<string[]> {
  const result = await collectMetrics(d.registry, d.brand, services.sources);
  await d.registry.setCursor(METRICS_AT_KEY, now.toISOString());
  return [`Metrics: ${result.readings} readings`, ...result.problems.map((p) => `  ${p}`)];
}
