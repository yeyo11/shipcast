import { Instagram } from '@shipcast/connectors';
import { collectMetrics, detect, draftLaunch, publishLaunch, type GitHubRest, type Launch, type PipelineDeps, type PublishResult, type Registry } from '@shipcast/engine';
import type { Brand } from '@shipcast/schema';
import { getJson, type SecretStore } from './secrets.ts';
import { accountSecretKey, buildServices, refreshInstagramToken, type Services } from './services.ts';

export const METRICS_EVERY_MS = 6 * 3600 * 1000;
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
  const result = await publishLaunch(launch, d.brand, { github: d.github, registry: d.registry, launchesRepo: d.pipeline.launchesRepo, publishers: services.publishers, search: services.sources.search });
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

/**
 * Refreshes every connected Instagram account's token that is 30 days old (they last 60), keeping
 * the fresh one in its keychain entry. Meta refuses to refresh a token younger than a day, so an
 * account seen for the first time only records the date.
 */
export async function refreshInstagramAccounts(d: Pick<RoundDeps, 'registry' | 'secrets'>, now = new Date(), http?: typeof fetch): Promise<string[]> {
  const lines: string[] = [];
  for (const account of d.registry.accounts({ network: 'instagram' })) {
    const remember = () => d.registry.updateAccount(account.id, { settings: { ...account.settings, refreshedAt: now.toISOString() } });
    const last = account.settings.refreshedAt;
    if (!last) {
      remember();
      continue;
    }
    if (now.getTime() - Date.parse(last) < TOKEN_REFRESH_EVERY_MS) continue;
    const secrets = await getJson(d.secrets, accountSecretKey(account.id));
    if (!secrets?.accessToken || !account.settings.userId) continue;
    try {
      const fresh = await new Instagram({ userId: account.settings.userId, accessToken: secrets.accessToken, fetch: http }).refreshToken();
      await d.secrets.set(accountSecretKey(account.id), JSON.stringify({ ...secrets, accessToken: fresh.accessToken }), `instagram ${account.label}`);
      remember();
      lines.push(`Instagram token of ${account.label} refreshed; valid for ${Math.round(fresh.expiresIn / 86400)} more days`);
    } catch (error) {
      lines.push(`Instagram token of ${account.label} not refreshed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return lines;
}

async function step(name: string, log: (line: string) => void, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    // One step failing never keeps the others from running this round
    log(`${name} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * One round of the work nobody has to start by hand: claim the account's new releases (when polling;
 * webhooks claim them as they happen), publish every drafted launch that is ready, refresh the
 * Instagram tokens that are due, and read the metrics every six hours. `shipcast watch` and the app
 * both run it.
 */
export async function runRound(d: RoundDeps, options: { detect: boolean; now?: Date }): Promise<void> {
  const log = d.log ?? (() => {});
  const now = options.now ?? new Date();
  const services = await buildServices({ env: d.env, brand: d.brand, registry: d.registry, github: d.github, secrets: d.secrets });

  if (options.detect) {
    await step('detect', log, async () => {
      for (const outcome of await detect({ github: d.github, registry: d.registry, brand: d.brand })) {
        if (outcome.result === 'claimed') await draftClaimed(outcome.launch, d, services);
        else if (outcome.result === 'invalid-config') log(`${outcome.event.repo}: ${outcome.launch.detail}`);
      }
    });
  }
  await step('publish', log, async () => {
    for (const launch of d.registry.recent(100).filter((l) => l.status === 'drafted')) await publishOne(launch, d, services);
  });
  await step('Instagram tokens', log, async () => {
    for (const line of await refreshInstagramAccounts(d, now)) log(line);
    // A token still read from .env is refreshed where it lives, in the registry
    if (services.instagram?.origin.kind === 'env') {
      const line = await refreshInstagramToken(services, d, now);
      if (line) log(line);
    }
  });
  const lastMetrics = Date.parse(d.registry.cursor(METRICS_AT_KEY) ?? '') || 0;
  if (now.getTime() - lastMetrics >= METRICS_EVERY_MS) {
    await step('metrics', log, async () => {
      const result = await collectMetrics(d.registry, d.brand, services.sources);
      d.registry.setCursor(METRICS_AT_KEY, now.toISOString());
      log(`Metrics: ${result.readings} readings`);
      for (const problem of result.problems) log(`  ${problem}`);
    });
  }
}
