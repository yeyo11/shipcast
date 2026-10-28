import { readFileSync } from 'node:fs';
import { bindStrategy, GitHubRest, type ChannelPublishing, type MetricSources, type Notifier, type PublishConnectors, type Publishers, type Repositories } from '@shipcast/engine';
import type { Brand, Channel } from '@shipcast/schema';
import { buildConnector, credentialsFromEnv, networkSpec, SOURCES, type Built } from './catalog.ts';
import { networkOf, type AnyChannelAdapter, type Credentials } from './channels/adapter.ts';
import { INSTAGRAM_REFRESHED_KEY, INSTAGRAM_TOKEN_KEY } from './channels/instagram.ts';
import { CHANNEL_ADAPTERS } from './channels/registry.ts';
import type { TokenBucket } from './redis/ports.ts';
import { getJson, type SecretStore } from './secrets.ts';

/** The keychain key of an account's secrets */
export const accountSecretKey = (id: number) => `account:${id}`;

/** Where a network's credentials came from: a connected account, or `.env` */
export type Origin = { kind: 'account'; id: number } | { kind: 'env' };

export interface ServiceDeps {
  env: NodeJS.ProcessEnv;
  brand: Brand;
  registry: Pick<Repositories, 'accounts' | 'cursors'>;
  /** The engine's GitHub client, also the metrics source while no GitHub account is connected */
  github: GitHubRest;
  secrets: SecretStore;
  readFile?: (path: string) => string;
  fetch?: typeof fetch;
  /** The channels' adapters; the registry's by default, and a test's with a channel added */
  adapters?: readonly AnyChannelAdapter[];
  /** The per-provider budgets every process shares, for the networks that keep a quota (redis/state.ts) */
  buckets?: TokenBucket;
}

export interface Services {
  publishers: Publishers;
  /** How the engine publishes the channels it has no run built in for: their adapters' strategies, bound to their publishers */
  strategies: Record<string, ChannelPublishing>;
  sources: MetricSources;
  /** The connector whose token `.env` still holds and Shipcast refreshes (Instagram's), with where it came from */
  instagram: { connector: { refreshToken(): Promise<{ accessToken: string; expiresIn: number }> }; origin: Origin } | undefined;
  /** The bot that tells the owner what is waiting, when one is connected (Telegram) */
  notifier: Notifier | undefined;
  /** Which channels and sources have credentials, for `shipcast status` and the first run */
  configured: string[];
  origins: Record<string, Origin>;
  /** The connected account each channel publishes with, so its pieces record it; a channel on `.env` has none */
  accounts: Partial<Record<Channel, number>>;
}

/** What publishing a launch is handed of the services: the engine's PublishConnectors */
export function publishConnectors(services: Services): PublishConnectors {
  return { publishers: services.publishers, strategies: services.strategies, search: services.sources.search, accounts: services.accounts };
}

/**
 * The brand `.env` speaks for: before the app, every credential lived there, and they are the
 * personal brand's. Another brand only ever publishes with accounts connected for it.
 */
export function envBrand(env: NodeJS.ProcessEnv): string {
  return env.SHIPCAST_ENV_BRAND?.trim() || 'personal';
}

/** A network's credentials for a brand: its primary account first, else `.env` for the brand it speaks for */
export async function credentialsFor(
  id: string,
  deps: Pick<ServiceDeps, 'env' | 'brand' | 'registry' | 'secrets' | 'readFile' | 'adapters'>,
): Promise<{ credentials: Credentials; origin: Origin } | undefined> {
  const account = await deps.registry.accounts.primaryAccount(deps.brand.id, id);
  if (account) {
    const secrets = await getJson(deps.secrets, accountSecretKey(account.id));
    if (secrets) return { credentials: { settings: account.settings, secrets }, origin: { kind: 'account', id: account.id } };
  }
  if (deps.brand.id !== envBrand(deps.env)) return undefined;
  const credentials = credentialsFromEnv(id, deps.env, deps.brand, deps.readFile ?? ((path) => readFileSync(path, 'utf8')), deps.adapters);
  return credentials ? { credentials, origin: { kind: 'env' } } : undefined;
}

/**
 * A token Shipcast refreshed while it still came from `.env` lives in the registry, and wins over
 * the one in `.env` (the network's `refresh.envToken`): publishing and editing read it the same way.
 */
export async function withRefreshedEnvToken(network: string, credentials: Credentials, registry: Pick<Repositories, 'cursors'>, adapters?: readonly AnyChannelAdapter[]): Promise<Credentials> {
  const key = networkSpec(network, adapters)?.refresh?.envToken?.tokenKey;
  const fresh = key ? await registry.cursors.cursor(key) : undefined;
  return fresh ? { ...credentials, secrets: { ...credentials.secrets, accessToken: fresh } } : credentials;
}

/**
 * The connectors for which credentials exist: a network without them is left out (and reported),
 * never half-configured. Accounts connected in the app win over `.env`. Every channel is wired by its
 * adapter (packages/runtime/src/channels): its publisher, its metric reader, its strategy.
 */
export async function buildServices(deps: ServiceDeps): Promise<Services> {
  const { brand, registry } = deps;
  const adapters = deps.adapters ?? CHANNEL_ADAPTERS;
  const publishers: Publishers = {};
  const strategies: Record<string, ChannelPublishing> = {};
  const posts: NonNullable<MetricSources['posts']> = {};
  const sources: MetricSources = { posts, github: deps.github };
  const configured: string[] = [];
  const origins: Record<string, Origin> = {};
  let instagram: Services['instagram'];
  let notifier: Notifier | undefined;

  const built = async (id: string): Promise<{ connection: Built; credentials: Credentials } | undefined> => {
    const found = await credentialsFor(id, { ...deps, adapters });
    if (!found) return undefined;
    const credentials = found.origin.kind === 'env' ? await withRefreshedEnvToken(id, found.credentials, registry, adapters) : found.credentials;
    try {
      const connection = buildConnector(id, credentials, brand, deps.fetch, { adapters, ...(deps.buckets && { buckets: deps.buckets }) });
      origins[id] = found.origin;
      return { connection, credentials };
    } catch {
      return undefined;
    }
  };

  for (const adapter of adapters) {
    const channel = adapter.definition.id;
    if (adapter.usable && !adapter.usable(brand)) continue;
    let connector: unknown;
    if (adapter.connect.kind === 'engine') {
      // No account to connect: the engine's own GitHub access (the App's installation) is the account
      connector = adapter.connect.build({ auth: deps.github.auth, fetch: deps.fetch });
      configured.push(adapter.connect.configured);
    } else {
      const network = adapter.connect.network;
      const found = await built(network.id);
      if (!found) continue;
      connector = found.connection.connector;
      if (network.refresh?.envToken) instagram = { connector: connector as NonNullable<Services['instagram']>['connector'], origin: origins[network.id]! };
      if (adapter.notifier) notifier = adapter.notifier(found.connection, found.credentials, deps.fetch);
      configured.push(channel);
    }
    const publisher = adapter.publisher(connector);
    // A built-in channel's publisher goes where the engine looks for it; a new one's goes with its strategy
    if (adapter.strategy) strategies[channel] = bindStrategy(adapter.strategy, publisher);
    else Object.assign(publishers, { [channel]: publisher });
    if (adapter.metrics) posts[channel as Channel] = adapter.metrics(connector);
  }

  // Stars, forks, watchers and the repo's traffic through the App's installation: traffic needs its
  // Administration: read, granted on 2026-10-26; without it the public numbers are read
  configured.push('github');
  for (const source of SOURCES) {
    if (!source.source) continue;
    const found = await built(source.id);
    if (!found) continue;
    // Each source's connector is what its slot of MetricSources reads (catalog.ts builds the right one)
    Object.assign(sources, { [source.source.slot]: found.connection.connector });
    configured.push(source.source.configured);
  }

  const accounts: Partial<Record<Channel, number>> = {};
  for (const adapter of adapters) {
    const id = networkOf(adapter)?.id;
    const origin = id === undefined ? undefined : origins[id];
    if (origin?.kind === 'account') accounts[adapter.definition.id as Channel] = origin.id;
  }
  return { publishers, strategies, sources, instagram, notifier, configured, origins, accounts };
}

/**
 * Refreshes the Instagram token every 30 days (it lasts 60), keeping the fresh one where the token
 * came from: the account's keychain entry, or the registry for a token from `.env`. Meta refuses to
 * refresh a token younger than 24 hours, so a first run only records the date.
 */
export async function refreshInstagramToken(
  services: Services,
  deps: { registry: Pick<Repositories, 'accounts' | 'cursors'>; secrets: SecretStore },
  now = new Date(),
): Promise<string | undefined> {
  if (!services.instagram) return undefined;
  const { connector, origin } = services.instagram;
  const { registry } = deps;
  const account = origin.kind === 'account' ? await registry.accounts.account(origin.id) : undefined;
  const last = account ? account.settings.refreshedAt : await registry.cursors.cursor(INSTAGRAM_REFRESHED_KEY);
  const remember = async (at: Date): Promise<void> => {
    if (account) await registry.accounts.updateAccount(account.id, { settings: { ...account.settings, refreshedAt: at.toISOString() } });
    else await registry.cursors.setCursor(INSTAGRAM_REFRESHED_KEY, at.toISOString());
  };
  if (!last) {
    await remember(now);
    return undefined;
  }
  if (now.getTime() - Date.parse(last) < 30 * 24 * 3600 * 1000) return undefined;
  const fresh = await connector.refreshToken();
  if (account) {
    const secrets = (await getJson(deps.secrets, accountSecretKey(account.id))) ?? {};
    await deps.secrets.set(accountSecretKey(account.id), JSON.stringify({ ...secrets, accessToken: fresh.accessToken }), `${account.network} ${account.label}`);
  } else {
    await registry.cursors.setCursor(INSTAGRAM_TOKEN_KEY, fresh.accessToken);
  }
  await remember(now);
  return `Instagram token refreshed; valid for ${Math.round(fresh.expiresIn / 86400)} more days`;
}
