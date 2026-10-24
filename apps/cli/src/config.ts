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
    claudioUrl: need('CLAUDIO_API_URL'),
    claudioToken: need('CLAUDIO_API_TOKEN'),
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
