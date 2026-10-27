import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { activeChannels, type Channel, type LaunchConfig, type PublishMode } from '@shipcast/schema';
import { ConfigError } from '../config.ts';
import { STATE_BRANCH } from './state.ts';

/*
 * `shipcast ci`'s configuration, read from the environment only: in GitHub Actions there is no `.env`,
 * no keychain and no app to set anything in, so every value is an input or an Actions secret mapped
 * to a variable by the workflow (docs/decisions/action-mode.md).
 */

export type CiGitHub =
  | { kind: 'token'; token: string; source: 'SHIPCAST_GITHUB_TOKEN' | 'GITHUB_TOKEN' }
  | { kind: 'app'; appId: string; privateKey: string; clientId: string | undefined };

export type CiAi =
  | { kind: 'anthropic'; apiKey: string; model: string | undefined }
  | { kind: 'openai'; apiKey: string; model: string | undefined }
  | { kind: 'openaiCompatible'; baseUrl: string; apiKey: string | undefined; model: string }
  /** Tests only: a placeholder pack, no model and no network (docs/decisions/github-action.md) */
  | { kind: 'fake' };

/** The values of SHIPCAST_AI_PROVIDER */
export const CI_AI_PROVIDERS = ['anthropic', 'openai', 'openai-compatible', 'fake'] as const;

export type CiStateConfig = { kind: 'branch'; remote: string; branch: string } | { kind: 'postgres'; url: string };

export interface CiConfig {
  launchesRepo: string;
  github: CiGitHub;
  /** Absent only when the command needs no AI (publish, a round without detection) or runs dry */
  ai: CiAi | undefined;
  state: CiStateConfig;
  /** Who takes the state's lease: the workflow run, so a lease names where to look */
  holder: string;
  leaseMs: number;
  waitMs: number;
  /** Where releases are cloned and temporary files written */
  workDir: string;
  /** The repo the workflow runs in: a manual launch's default */
  currentRepo: string | undefined;
}

const REPO = /^[\w.-]+\/[\w.-]+$/;

function minutes(env: NodeJS.ProcessEnv, name: string, fallback: number, problems: string[]): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback * 60_000;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    problems.push(`${name} must be a positive number of minutes, not "${raw}"`);
    return fallback * 60_000;
  }
  return value * 60_000;
}

/**
 * Reads the configuration, reporting every problem at once. `needAi` is false for the commands that
 * draft nothing, and for a dry run, which prints what it would ask the AI without asking it.
 */
export function loadCiConfig(env: NodeJS.ProcessEnv, options: { needAi: boolean }): CiConfig {
  const problems: string[] = [];
  const value = (name: string) => env[name]?.trim() || undefined;

  const launchesRepo = value('SHIPCAST_LAUNCHES_REPO') ?? '';
  if (!launchesRepo) problems.push('SHIPCAST_LAUNCHES_REPO (the launches repo, owner/name)');
  else if (!REPO.test(launchesRepo)) problems.push(`SHIPCAST_LAUNCHES_REPO must be owner/name, not "${launchesRepo}"`);

  let github: CiGitHub | undefined;
  const appId = value('SHIPCAST_GITHUB_APP_ID');
  const privateKey = value('SHIPCAST_GITHUB_APP_PRIVATE_KEY')?.replace(/\\n/g, '\n');
  const token = value('SHIPCAST_GITHUB_TOKEN');
  if (token) github = { kind: 'token', token, source: 'SHIPCAST_GITHUB_TOKEN' };
  else if (appId || privateKey) {
    if (!appId || !privateKey) problems.push('the GitHub App needs both SHIPCAST_GITHUB_APP_ID and SHIPCAST_GITHUB_APP_PRIVATE_KEY');
    else if (!privateKey.includes('PRIVATE KEY')) problems.push('SHIPCAST_GITHUB_APP_PRIVATE_KEY is not a PEM private key');
    else github = { kind: 'app', appId, privateKey, clientId: value('SHIPCAST_GITHUB_APP_CLIENT_ID') };
  } else if (value('GITHUB_TOKEN')) github = { kind: 'token', token: value('GITHUB_TOKEN')!, source: 'GITHUB_TOKEN' };
  else problems.push('a GitHub token: SHIPCAST_GITHUB_TOKEN, or SHIPCAST_GITHUB_APP_ID with SHIPCAST_GITHUB_APP_PRIVATE_KEY');

  let ai: CiAi | undefined;
  const model = value('SHIPCAST_AI_MODEL');
  const genericKey = value('SHIPCAST_AI_API_KEY');
  const baseUrl = value('SHIPCAST_AI_BASE_URL');
  // Chosen by a variable; without it, the variables that are set decide, as before the variable existed
  const chosen = value('SHIPCAST_AI_PROVIDER')?.toLowerCase() ?? (value('ANTHROPIC_API_KEY') ? 'anthropic' : baseUrl ? 'openai-compatible' : value('OPENAI_API_KEY') ? 'openai' : undefined);
  const compatible = () => {
    if (!baseUrl) problems.push('SHIPCAST_AI_BASE_URL, the OpenAI-compatible server');
    else if (!/^https?:\/\/\S+$/.test(baseUrl)) problems.push(`SHIPCAST_AI_BASE_URL must be http(s)://…, not "${baseUrl}"`);
    else if (!model) problems.push('SHIPCAST_AI_MODEL, which an OpenAI-compatible server needs');
    else ai = { kind: 'openaiCompatible', baseUrl, apiKey: genericKey, model };
  };
  if (chosen === 'anthropic') {
    const apiKey = value('ANTHROPIC_API_KEY') ?? genericKey;
    if (apiKey) ai = { kind: 'anthropic', apiKey, model };
    else if (options.needAi) problems.push('ANTHROPIC_API_KEY (or SHIPCAST_AI_API_KEY), the Anthropic API key');
  } else if (chosen === 'openai') {
    const apiKey = value('OPENAI_API_KEY') ?? genericKey;
    if (apiKey) ai = { kind: 'openai', apiKey, model };
    else if (options.needAi) problems.push('OPENAI_API_KEY (or SHIPCAST_AI_API_KEY), the OpenAI API key');
  } else if (chosen === 'openai-compatible' || chosen === 'openaicompatible') {
    if (baseUrl || options.needAi) compatible();
  } else if (chosen === 'fake') ai = { kind: 'fake' };
  else if (chosen !== undefined) problems.push(`SHIPCAST_AI_PROVIDER must be one of ${CI_AI_PROVIDERS.join(', ')}, not "${chosen}"`);
  else if (options.needAi) problems.push('an AI provider: SHIPCAST_AI_PROVIDER (anthropic or openai) with its key, ANTHROPIC_API_KEY or OPENAI_API_KEY');

  const databaseUrl = value('SHIPCAST_DATABASE_URL');
  if (databaseUrl && !/^postgres(ql)?:\/\//.test(databaseUrl)) problems.push('SHIPCAST_DATABASE_URL must be a postgres:// URL');
  const state: CiStateConfig = databaseUrl
    ? { kind: 'postgres', url: databaseUrl }
    : { kind: 'branch', remote: value('SHIPCAST_STATE_REMOTE') ?? `https://github.com/${launchesRepo}.git`, branch: value('SHIPCAST_STATE_BRANCH') ?? STATE_BRANCH };

  const leaseMs = minutes(env, 'SHIPCAST_STATE_LEASE_MINUTES', 30, problems);
  const waitMs = minutes(env, 'SHIPCAST_STATE_WAIT_MINUTES', 45, problems);

  if (problems.length > 0) throw new ConfigError(`shipcast ci is missing or refuses:\n${problems.map((p) => `  - ${p}`).join('\n')}`);

  const run = value('GITHUB_RUN_ID');
  const currentRepo = value('GITHUB_REPOSITORY');
  return {
    launchesRepo,
    github: github!,
    ai,
    state,
    holder: run ? `${currentRepo ?? 'a repo'} run ${run}.${value('GITHUB_RUN_ATTEMPT') ?? '1'}` : `process ${process.pid}`,
    leaseMs,
    waitMs,
    workDir: join(value('RUNNER_TEMP') ?? tmpdir(), 'shipcast'),
    currentRepo,
  };
}

/**
 * The environment the networks' credentials are read from (`credentialsFromEnv`): the variables a
 * local `.env` uses, which the workflow maps from Actions secrets. CI speaks for one brand, the
 * launches repo's, so `.env`'s brand is set to it; the Search Console key arrives as text and is
 * written to a file, since a secret cannot be a file.
 */
export function networkEnv(env: NodeJS.ProcessEnv, brandId: string, workDir: string, writeFile: (path: string, content: string) => void): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env, SHIPCAST_ENV_BRAND: env.SHIPCAST_ENV_BRAND?.trim() || brandId };
  const json = env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  if (json && !env.GOOGLE_SERVICE_ACCOUNT_FILE?.trim()) {
    const path = join(workDir, 'google-service-account.json');
    writeFile(path, json);
    out.GOOGLE_SERVICE_ACCOUNT_FILE = path;
  }
  return out;
}

/** The networks' variables, in the order the action documents them; their secrets are named the same */
export const NETWORK_VARIABLES = [
  'DEVTO_API_KEY',
  'BLUESKY_HANDLE',
  'BLUESKY_APP_PASSWORD',
  'MASTODON_INSTANCE',
  'MASTODON_ACCESS_TOKEN',
  'INSTAGRAM_USER_ID',
  'INSTAGRAM_ACCESS_TOKEN',
  'BREVO_API_KEY',
  'HASHNODE_TOKEN',
  'HASHNODE_PUBLICATION_HOST',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  'TELEGRAM_NOTIFY_CHAT_ID',
  'DISCORD_WEBHOOK_URL',
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_WEB_ANALYTICS_SITE_TAG',
  'GOOGLE_SERVICE_ACCOUNT_JSON',
  'BING_WEBMASTER_API_KEY',
] as const;

/** The variables each channel publishes with in Action mode, the first set preferred */
const CHANNEL_VARIABLES: Partial<Record<Channel, string[][]>> = {
  devto: [['DEVTO_API_KEY']],
  // The handle and the instance can also come from brand.yml's profile links
  bluesky: [['BLUESKY_HANDLE', 'BLUESKY_APP_PASSWORD'], ['BLUESKY_APP_PASSWORD']],
  mastodon: [['MASTODON_INSTANCE', 'MASTODON_ACCESS_TOKEN'], ['MASTODON_ACCESS_TOKEN']],
  instagram: [['INSTAGRAM_USER_ID', 'INSTAGRAM_ACCESS_TOKEN']],
  hashnode: [['HASHNODE_TOKEN', 'HASHNODE_PUBLICATION_HOST']],
  telegram: [['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']],
  discord: [['DISCORD_WEBHOOK_URL']],
  newsletter: [['BREVO_API_KEY']],
};

/** Each channel a launch turns on, its mode, and whether Action mode can publish it with this environment */
export interface ChannelPlan {
  channel: Channel;
  mode: PublishMode;
  ready: boolean;
  /** What it publishes with, or why it would not publish */
  note: string;
}

/**
 * What publishing a launch would do, channel by channel, for a dry run. Only the variables' names are
 * looked at, never a value. Reddit, LinkedIn and Threads sign in through the app, which Action mode
 * does not have.
 */
export function channelPlan(config: LaunchConfig, env: NodeJS.ProcessEnv): ChannelPlan[] {
  const set = (name: string) => Boolean(env[name]?.trim());
  return activeChannels(config).map((channel) => {
    const mode = config.publishing[channel];
    if (channel === 'blog') return { channel, mode, ready: true, note: 'the merge of the drafts pull request publishes it' };
    if (channel === 'githubDiscussions') return { channel, mode, ready: true, note: 'posted with the GitHub token' };
    const options = CHANNEL_VARIABLES[channel];
    if (!options) return { channel, mode, ready: false, note: 'needs a sign-in through the app: not available in Action mode' };
    const found = options.find((names) => names.every(set));
    if (found) return { channel, mode, ready: true, note: `credentials set (${found.join(', ')})` };
    const wanted = options[0]!;
    return { channel, mode, ready: false, note: `not published: set the secret${wanted.length > 1 ? 's' : ''} ${wanted.join(' and ')}` };
  });
}
