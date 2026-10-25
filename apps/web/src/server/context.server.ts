import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkout, Claudio, GitHubRest, loadBrand, Registry, type PipelineDeps } from '@shipcast/engine';
import { KeychainStore, loadAppConfig, loadConfig, type AppConfig, type Config, type SecretStore } from '@shipcast/runtime';
import type { Brand } from '@shipcast/schema';
import { Jobs } from './jobs.server';

/** The repository's root, where `.env`, `data/` and `workspace/` live, whatever directory the app runs from */
export const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..');

export interface AppContext {
  config: Config;
  app: AppConfig;
  registry: Registry;
  github: GitHubRest;
  secrets: SecretStore;
  deps: PipelineDeps;
  jobs: Jobs;
  /** The brand the launches repo speaks for, read again every few minutes */
  brand(): Promise<Brand>;
  /** Every brand, by id; one per launches repo, so one today */
  brands(): Promise<Map<string, Brand>>;
}

let context: AppContext | undefined;

/** One context per process: one registry connection, one keychain, one job list. */
export function appContext(): AppContext {
  if (context) return context;
  const config = loadConfig(process.env, ROOT);
  const app = loadAppConfig(process.env);
  mkdirSync(config.dataDir, { recursive: true });
  const registry = new Registry(join(config.dataDir, 'shipcast.db'));
  const github = new GitHubRest({ token: config.githubToken });
  const deps: PipelineDeps = {
    github,
    ai: new Claudio({ url: config.claudioUrl, token: config.claudioToken }),
    registry,
    launchesRepo: config.launchesRepo,
    checkout: (repo, ref) => checkout({ hostDir: config.workspaceHostDir, providerDir: config.workspaceProviderDir }, repo, ref),
    maxBudgetUsd: config.maxBudgetUsd,
  };
  let cached: { brand: Brand; at: number } | undefined;
  const brand = async () => {
    if (!cached || Date.now() - cached.at > 5 * 60_000) cached = { brand: await loadBrand(github, config.launchesRepo), at: Date.now() };
    return cached.brand;
  };
  context = {
    config,
    app,
    registry,
    github,
    secrets: new KeychainStore(),
    deps,
    jobs: new Jobs(),
    brand,
    brands: async () => {
      const b = await brand();
      return new Map([[b.id, b]]);
    },
  };
  return context;
}
