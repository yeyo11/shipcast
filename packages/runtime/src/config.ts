import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

/** The GitHub App Shipcast signs in and works through (docs/decisions/github-app.md) */
export interface GitHubAppConfig {
  appId: string;
  /** Its URL name; the commits it makes are by `<slug>[bot]` */
  slug: string | undefined;
  clientId: string;
  clientSecret: string;
  /** Signs the App's webhook deliveries */
  webhookSecret: string | undefined;
  /** PEM, read from SHIPCAST_GITHUB_APP_PRIVATE_KEY_FILE */
  privateKey: string;
}

/**
 * The bootstrap: what Shipcast needs before anyone signs in, and the only thing read from `.env`.
 * Everything else is a setting (`settings.ts`), kept in the database and the keychain.
 */
export interface Config {
  /** The repository's root, where `.env`, `data/` and `workspace/` live */
  root: string;
  /** The Postgres the registry lives in, `postgres://user:password@host:port/database` */
  databaseUrl: string;
  /** Files Shipcast keeps on disk, such as the TLS certificate; the registry is in Postgres */
  dataDir: string;
  workspaceHostDir: string;
  workspaceProviderDir: string;
  /** The keychain's service name; another one keeps a second install's secrets apart */
  keychainService: string;
  githubApp: GitHubAppConfig | undefined;
  /**
   * The engine's GitHub token from before the App, kept only for an install without one: with the
   * App configured it is not used by the engine (see services.ts for the metrics' traffic)
   */
  githubToken: string | undefined;
  /** GitHub logins allowed in; the first is the owner, whose installation the App uses before a launches repo is set */
  allowedLogins: string[];
}

export class ConfigError extends Error {}

const APP_VARIABLES = ['SHIPCAST_GITHUB_APP_ID', 'SHIPCAST_GITHUB_APP_CLIENT_ID', 'SHIPCAST_GITHUB_APP_CLIENT_SECRET'] as const;

/** Loads `.env` from the root into the process, once, when the process's own environment is being read */
function loadEnvFile(env: NodeJS.ProcessEnv, root: string): void {
  const envFile = resolve(root, '.env');
  if (env === process.env && existsSync(envFile)) process.loadEnvFile(envFile);
}

function readGitHubApp(env: NodeJS.ProcessEnv, root: string, readFile: (path: string) => string): GitHubAppConfig | undefined {
  const value = (name: string) => env[name]?.trim() || undefined;
  const keyFile = value('SHIPCAST_GITHUB_APP_PRIVATE_KEY_FILE');
  const inline = value('SHIPCAST_GITHUB_APP_PRIVATE_KEY');
  const given = [...APP_VARIABLES.filter((n) => value(n)), ...(keyFile || inline ? ['the private key'] : [])];
  if (given.length === 0) return undefined;
  const missing = [...APP_VARIABLES.filter((n) => !value(n)), ...(keyFile || inline ? [] : ['SHIPCAST_GITHUB_APP_PRIVATE_KEY_FILE'])];
  // Half an App is a mistake worth stopping for, not a reason to fall back to the old token in silence
  if (missing.length > 0) throw new ConfigError(`the GitHub App is half set in .env: missing ${missing.join(', ')} (see .env.example)`);
  let privateKey = inline?.replace(/\\n/g, '\n');
  if (keyFile) {
    const path = isAbsolute(keyFile) ? keyFile : resolve(root, keyFile);
    try {
      privateKey = readFile(path);
    } catch {
      throw new ConfigError(`SHIPCAST_GITHUB_APP_PRIVATE_KEY_FILE: cannot read ${keyFile}`);
    }
  }
  if (!privateKey?.includes('PRIVATE KEY')) throw new ConfigError('the GitHub App private key is not a PEM private key');
  return {
    appId: value('SHIPCAST_GITHUB_APP_ID')!,
    slug: value('SHIPCAST_GITHUB_APP_SLUG'),
    clientId: value('SHIPCAST_GITHUB_APP_CLIENT_ID')!,
    clientSecret: value('SHIPCAST_GITHUB_APP_CLIENT_SECRET')!,
    webhookSecret: value('SHIPCAST_GITHUB_APP_WEBHOOK_SECRET'),
    privateKey,
  };
}

/**
 * Reads the bootstrap from the environment, loading `.env` from the root first if there is one. It
 * asks for the database and a way to reach GitHub (the App, or the old token); the launches repo,
 * claudio and the rest are settings, so their absence never stops a start.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, root = process.cwd(), readFile = (path: string) => readFileSync(path, 'utf8')): Config {
  loadEnvFile(env, root);
  const databaseUrl = env.SHIPCAST_DATABASE_URL?.trim() ?? '';
  if (!databaseUrl) throw new ConfigError('missing in .env: SHIPCAST_DATABASE_URL (see .env.example)');
  // Not echoed back: the URL carries the database password
  if (!/^postgres(ql)?:\/\//.test(databaseUrl)) throw new ConfigError('SHIPCAST_DATABASE_URL must be a postgres:// URL');
  const githubApp = readGitHubApp(env, root, readFile);
  const githubToken = env.GITHUB_TOKEN_PERSONAL?.trim() || undefined;
  if (!githubApp && !githubToken) {
    throw new ConfigError('missing in .env: the GitHub App (SHIPCAST_GITHUB_APP_ID, …) or, without one, GITHUB_TOKEN_PERSONAL (see .env.example)');
  }
  return {
    root,
    databaseUrl,
    dataDir: resolve(root, env.SHIPCAST_DATA_DIR?.trim() || 'data'),
    // claudio mounts the repo's ./workspace as /workspace (docker-compose.yml)
    workspaceHostDir: resolve(root, 'workspace'),
    workspaceProviderDir: '/workspace',
    keychainService: env.SHIPCAST_KEYCHAIN_SERVICE?.trim() || 'shipcast',
    githubApp,
    githubToken,
    allowedLogins: (env.SHIPCAST_ALLOWED_GITHUB ?? '')
      .split(',')
      .map((l) => l.trim().toLowerCase())
      .filter(Boolean),
  };
}

/** What the web app needs besides the engine's bootstrap: still `.env`, since it is needed before a sign-in */
export interface AppConfig {
  /** The app's address, `https://…` without a trailing slash: OAuth callbacks are built on it */
  publicUrl: string;
  /** The client the owner signs in through: the GitHub App's, or the old OAuth App's while there is no App */
  github: { clientId: string; clientSecret: string; kind: 'app' | 'oauth-app' };
  /** GitHub logins allowed in; everyone else is turned away after signing in */
  allowedLogins: string[];
  /** Where the app listens; Tailscale Serve forwards the tailnet's port 443 to it */
  host: string;
  port: number;
  /** A Cloudflare token with Zone DNS edit, for the certificate's DNS challenge; plain HTTP on localhost without it */
  tlsCloudflareToken: string | undefined;
}

/** Reads the app's part of the bootstrap; every missing variable is reported at once. */
export function loadAppConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const missing: string[] = [];
  const need = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) missing.push(name);
    return value ?? '';
  };
  const appClient = env.SHIPCAST_GITHUB_APP_CLIENT_ID?.trim();
  const appSecret = env.SHIPCAST_GITHUB_APP_CLIENT_SECRET?.trim();
  const github: AppConfig['github'] =
    appClient && appSecret
      ? { clientId: appClient, clientSecret: appSecret, kind: 'app' }
      : env.SHIPCAST_GITHUB_CLIENT_ID?.trim() || env.SHIPCAST_GITHUB_CLIENT_SECRET?.trim()
        ? { clientId: need('SHIPCAST_GITHUB_CLIENT_ID'), clientSecret: need('SHIPCAST_GITHUB_CLIENT_SECRET'), kind: 'oauth-app' }
        : { clientId: need('SHIPCAST_GITHUB_APP_CLIENT_ID'), clientSecret: need('SHIPCAST_GITHUB_APP_CLIENT_SECRET'), kind: 'app' };
  const config: AppConfig = {
    publicUrl: need('SHIPCAST_PUBLIC_URL').replace(/\/+$/, ''),
    github,
    allowedLogins: need('SHIPCAST_ALLOWED_GITHUB')
      .split(',')
      .map((l) => l.trim().toLowerCase())
      .filter(Boolean),
    host: env.SHIPCAST_APP_HOST?.trim() || '127.0.0.1',
    port: Number(env.SHIPCAST_APP_PORT ?? 8744),
    tlsCloudflareToken: env.SHIPCAST_TLS_CLOUDFLARE_TOKEN?.trim() || undefined,
  };
  if (missing.length > 0) throw new ConfigError(`missing in .env for the app: ${missing.join(', ')} (see .env.example)`);
  if (!/^https:\/\/[^/]+$/.test(config.publicUrl)) throw new ConfigError(`SHIPCAST_PUBLIC_URL must be https://host, not "${config.publicUrl}"`);
  if (!Number.isInteger(config.port) || config.port <= 0) throw new ConfigError('SHIPCAST_APP_PORT must be a port number');
  return config;
}
