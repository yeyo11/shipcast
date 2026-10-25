import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** What the engine needs from the environment, checked once at start. */
export interface Config {
  githubToken: string;
  claudioUrl: string;
  claudioToken: string;
  launchesRepo: string;
  dataDir: string;
  workspaceHostDir: string;
  workspaceProviderDir: string;
  maxBudgetUsd: number | undefined;
}

export class ConfigError extends Error {}

/**
 * Reads the configuration from the environment, loading `.env` from the working directory first if
 * there is one. Every missing variable is reported at once, so a first run fails with the whole list.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): Config {
  const envFile = resolve(cwd, '.env');
  if (env === process.env && existsSync(envFile)) process.loadEnvFile(envFile);

  const missing: string[] = [];
  const need = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) missing.push(name);
    return value ?? '';
  };
  const config: Config = {
    githubToken: need('GITHUB_TOKEN_PERSONAL'),
    claudioUrl: need('SHIPCAST_CLAUDIO_URL'),
    claudioToken: need('SHIPCAST_CLAUDIO_TOKEN'),
    launchesRepo: need('SHIPCAST_LAUNCHES_REPO'),
    dataDir: resolve(cwd, env.SHIPCAST_DATA_DIR?.trim() || 'data'),
    // claudio mounts the repo's ./workspace as /workspace (docker-compose.yml)
    workspaceHostDir: resolve(cwd, 'workspace'),
    workspaceProviderDir: '/workspace',
    maxBudgetUsd: env.SHIPCAST_MAX_BUDGET_USD ? Number(env.SHIPCAST_MAX_BUDGET_USD) : undefined,
  };
  if (missing.length > 0) throw new ConfigError(`missing in .env: ${missing.join(', ')} (see .env.example)`);
  if (!/^[\w.-]+\/[\w.-]+$/.test(config.launchesRepo)) {
    throw new ConfigError(`SHIPCAST_LAUNCHES_REPO must be owner/name, not "${config.launchesRepo}"`);
  }
  if (config.maxBudgetUsd !== undefined && !(config.maxBudgetUsd > 0)) {
    throw new ConfigError('SHIPCAST_MAX_BUDGET_USD must be a positive number');
  }
  return config;
}

/** What the web app needs besides the engine's configuration. */
export interface AppConfig {
  /** The app's address, `https://…` without a trailing slash: OAuth callbacks are built on it */
  publicUrl: string;
  github: { clientId: string; clientSecret: string };
  /** GitHub logins allowed in; everyone else is turned away after signing in */
  allowedLogins: string[];
  /** For Instagram Login; without it Instagram is connected from `.env` only */
  instagram: { appId: string; appSecret: string } | undefined;
  /** Where the app listens; Tailscale Serve forwards the tailnet's port 443 to it */
  host: string;
  port: number;
  /** A Cloudflare token with Zone DNS edit, for the certificate's DNS challenge; plain HTTP on localhost without it */
  tlsCloudflareToken: string | undefined;
}

/** Reads the app's configuration; like `loadConfig`, every missing variable is reported at once. */
export function loadAppConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const missing: string[] = [];
  const need = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) missing.push(name);
    return value ?? '';
  };
  const config: AppConfig = {
    publicUrl: need('SHIPCAST_PUBLIC_URL').replace(/\/+$/, ''),
    github: { clientId: need('SHIPCAST_GITHUB_CLIENT_ID'), clientSecret: need('SHIPCAST_GITHUB_CLIENT_SECRET') },
    allowedLogins: need('SHIPCAST_ALLOWED_GITHUB')
      .split(',')
      .map((l) => l.trim().toLowerCase())
      .filter(Boolean),
    instagram:
      env.INSTAGRAM_APP_ID?.trim() && env.INSTAGRAM_APP_SECRET?.trim()
        ? { appId: env.INSTAGRAM_APP_ID.trim(), appSecret: env.INSTAGRAM_APP_SECRET.trim() }
        : undefined,
    host: env.SHIPCAST_APP_HOST?.trim() || '127.0.0.1',
    port: Number(env.SHIPCAST_APP_PORT ?? 8744),
    tlsCloudflareToken: env.SHIPCAST_TLS_CLOUDFLARE_TOKEN?.trim() || undefined,
  };
  if (missing.length > 0) throw new ConfigError(`missing in .env for the app: ${missing.join(', ')} (see .env.example)`);
  if (!/^https:\/\/[^/]+$/.test(config.publicUrl)) throw new ConfigError(`SHIPCAST_PUBLIC_URL must be https://host, not "${config.publicUrl}"`);
  if (!Number.isInteger(config.port) || config.port <= 0) throw new ConfigError('SHIPCAST_APP_PORT must be a port number');
  return config;
}
