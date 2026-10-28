import { readFileSync } from 'node:fs';
import { GitHubDiscussions, Telegram, type Instagram } from '@shipcast/connectors';
import { GitHubRest, type MetricSources, type Publishers, type Repositories } from '@shipcast/engine';
import type { Brand, Channel } from '@shipcast/schema';
import { buildConnector, credentialsFromEnv, NETWORKS, type Built, type Credentials } from './catalog.ts';
import { getJson, type SecretStore } from './secrets.ts';

/** Where a refreshed Instagram token is kept when it came from `.env`: in the registry, never in a file in the repo. */
export const INSTAGRAM_TOKEN_KEY = 'instagram-token';
export const INSTAGRAM_REFRESHED_KEY = 'instagram-token-refreshed-at';

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
}

export interface Services {
  publishers: Publishers;
  sources: MetricSources;
  instagram: { connector: Instagram; origin: Origin } | undefined;
  /** The bot that tells the owner what is waiting, when Telegram is connected */
  notifier: Telegram | undefined;
  /** Which channels and sources have credentials, for `shipcast status` and the first run */
  configured: string[];
  origins: Record<string, Origin>;
  /** The connected account each channel publishes with, so its pieces record it; a channel on `.env` has none */
  accounts: Partial<Record<Channel, number>>;
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
  deps: Pick<ServiceDeps, 'env' | 'brand' | 'registry' | 'secrets' | 'readFile'>,
): Promise<{ credentials: Credentials; origin: Origin } | undefined> {
  const account = await deps.registry.accounts.primaryAccount(deps.brand.id, id);
  if (account) {
    const secrets = await getJson(deps.secrets, accountSecretKey(account.id));
    if (secrets) return { credentials: { settings: account.settings, secrets }, origin: { kind: 'account', id: account.id } };
  }
  if (deps.brand.id !== envBrand(deps.env)) return undefined;
  const credentials = credentialsFromEnv(id, deps.env, deps.brand, deps.readFile ?? ((path) => readFileSync(path, 'utf8')));
  return credentials ? { credentials, origin: { kind: 'env' } } : undefined;
}

/**
 * The connectors for which credentials exist: a network without them is left out (and reported),
 * never half-configured. Accounts connected in the app win over `.env`.
 */
export async function buildServices(deps: ServiceDeps): Promise<Services> {
  const { brand, registry } = deps;
  const publishers: Publishers = {};
  const posts: NonNullable<MetricSources['posts']> = {};
  const sources: MetricSources = { posts, github: deps.github };
  const configured: string[] = [];
  const origins: Record<string, Origin> = {};
  let instagram: Services['instagram'];
  let notifier: Telegram | undefined;

  const built = async (id: string): Promise<Built | undefined> => {
    const found = await credentialsFor(id, deps);
    if (!found) return undefined;
    let credentials = found.credentials;
    // A token Shipcast refreshed while it still came from .env lives in the registry
    if (id === 'instagram' && found.origin.kind === 'env') {
      const fresh = await registry.cursors.cursor(INSTAGRAM_TOKEN_KEY);
      if (fresh) credentials = { ...credentials, secrets: { ...credentials.secrets, accessToken: fresh } };
    }
    try {
      const connector = buildConnector(id, credentials, brand, deps.fetch);
      origins[id] = found.origin;
      return connector;
    } catch {
      return undefined;
    }
  };

  const devto = (await built('devto'))?.devto;
  if (devto) {
    publishers.devto = posts.devto = devto;
    configured.push('devto');
  }
  const bluesky = (await built('bluesky'))?.bluesky;
  if (bluesky) {
    publishers.bluesky = posts.bluesky = bluesky;
    configured.push('bluesky');
  }
  const mastodon = (await built('mastodon'))?.mastodon;
  if (mastodon) {
    publishers.mastodon = posts.mastodon = mastodon;
    configured.push('mastodon');
  }
  const ig = (await built('instagram'))?.instagram;
  if (ig) {
    publishers.instagram = posts.instagram = ig;
    instagram = { connector: ig, origin: origins.instagram! };
    configured.push('instagram');
  }
  const brevo = brand.newsletter ? (await built('brevo'))?.brevo : undefined;
  if (brevo) {
    publishers.newsletter = posts.newsletter = brevo;
    configured.push('newsletter');
  }
  const hashnode = (await built('hashnode'))?.hashnode;
  if (hashnode) {
    publishers.hashnode = posts.hashnode = hashnode;
    configured.push('hashnode');
  }
  const telegram = (await built('telegram'))?.telegram;
  if (telegram) {
    publishers.telegram = telegram;
    // Notices go to the owner's own chat with the bot when one is set, not to the public channel
    const found = await credentialsFor('telegram', deps);
    const notifyChat = found?.credentials.settings.notifyChatId?.trim();
    notifier = notifyChat && found ? new Telegram({ botToken: found.credentials.secrets.botToken!, chatId: notifyChat, fetch: deps.fetch }) : telegram;
    configured.push('telegram');
  }
  const discord = (await built('discord'))?.discord;
  if (discord) {
    publishers.discord = discord;
    configured.push('discord');
  }
  const threads = (await built('threads'))?.threads;
  if (threads) {
    publishers.threads = posts.threads = threads;
    configured.push('threads');
  }
  const linkedin = (await built('linkedin'))?.linkedin;
  if (linkedin) {
    // No metrics: a member's numbers need LinkedIn's Community Management API
    publishers.linkedin = linkedin;
    configured.push('linkedin');
  }
  const reddit = (await built('reddit'))?.reddit;
  if (reddit) {
    publishers.reddit = reddit;
    configured.push('reddit');
  }
  // No account to connect: the engine's own GitHub access (the App's installation) posts it
  const discussions = new GitHubDiscussions({ auth: deps.github.auth, ...(deps.fetch && { fetch: deps.fetch }) });
  publishers.githubDiscussions = posts.githubDiscussions = discussions;
  configured.push('github discussions');

  // Stars, forks, watchers and the repo's traffic through the App's installation: traffic needs its
  // Administration: read, granted on 2026-10-26; without it the public numbers are read
  configured.push('github');
  const cloudflare = (await built('cloudflare'))?.cloudflare;
  if (cloudflare) {
    sources.blog = cloudflare;
    configured.push('blog analytics');
  }
  const search = (await built('searchConsole'))?.searchConsole;
  if (search) {
    sources.search = search;
    configured.push('search console');
  }
  const bing = (await built('bingWebmaster'))?.bing;
  if (bing) {
    sources.bing = bing;
    configured.push('bing webmaster');
  }
  const accounts: Partial<Record<Channel, number>> = {};
  for (const network of NETWORKS) {
    const origin = origins[network.id];
    if (network.channel && origin?.kind === 'account') accounts[network.channel] = origin.id;
  }
  return { publishers, sources, instagram, notifier, configured, origins, accounts };
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
