import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { checkout, Claudio, GitHubRest, loadBrand, Registry, type PipelineDeps } from '@shipcast/engine';
import { aiSetup, KeychainStore, loadAppConfig, loadConfig, startWorking, WorkQueue, type AppConfig, type Config, type SecretStore, type WorkDeps } from '@shipcast/runtime';
import type { Brand } from '@shipcast/schema';

/**
 * The repository's root, where `.env`, `data/` and `workspace/` live: the nearest folder up from where
 * the app runs that holds `pnpm-workspace.yaml`. Not from this file's path, which differs between
 * Vite's development server and the bundled build.
 */
function findRoot(from: string): string {
  for (let dir = from; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    if (dirname(dir) === dir) return from;
  }
}

export const ROOT = process.env.SHIPCAST_ROOT ?? findRoot(process.cwd());

export interface AppContext {
  config: Config;
  app: AppConfig;
  registry: Registry;
  github: GitHubRest;
  secrets: SecretStore;
  deps: PipelineDeps;
  /** The durable work: pg-boss on the registry's Postgres, worked by this process */
  queue: WorkQueue;
  /** The brand the launches repo speaks for, read again every few minutes */
  brand(): Promise<Brand>;
  /** Every brand, by id; one per launches repo, so one today */
  brands(): Promise<Map<string, Brand>>;
}

let context: Promise<AppContext> | undefined;

/**
 * One context per process: one registry connection, one keychain, one queue. A promise, since
 * connecting to Postgres (and applying its migrations) is; every request after the first gets the
 * same one, and a failed start is tried again by the next request instead of being kept.
 */
export function appContext(): Promise<AppContext> {
  context ??= createContext().catch((error: unknown) => {
    context = undefined;
    throw error;
  });
  return context;
}

async function createContext(): Promise<AppContext> {
  const config = loadConfig(process.env, ROOT);
  const app = loadAppConfig(process.env);
  const registry = await Registry.connect(config.databaseUrl);
  const github = new GitHubRest({ token: config.githubToken });
  const secrets = new KeychainStore();
  const deps: PipelineDeps = {
    github,
    ai: new Claudio({ url: config.claudioUrl, token: config.claudioToken }),
    aiSetup: aiSetup({
      env: process.env,
      registry,
      secrets,
      claudio: { url: config.claudioUrl, token: config.claudioToken },
      // Read when an AI call is made, by then `brand` below exists
      brand: () => brand(),
    }),
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
  const queue = WorkQueue.postgres(config.databaseUrl, registry, { instanceName: 'app' });
  const work: WorkDeps = { env: process.env, registry, github, secrets, pipeline: deps, brand };
  const ctx: AppContext = {
    config,
    app,
    registry,
    github,
    secrets,
    deps,
    queue,
    brand,
    brands: async () => {
      const b = await brand();
      return new Map([[b.id, b]]);
    },
  };
  // The app works every queue: what it sends, and the rounds and schedules nobody starts by hand
  await startWorking(queue, work);
  stopOnSignal(queue, registry);
  return ctx;
}

/**
 * On SIGTERM or SIGINT the workers stop taking jobs and the running ones get a while to finish; one
 * still running after that is expired and retried (or failed) by pg-boss, never silently lost.
 */
function stopOnSignal(queue: WorkQueue, registry: Registry): void {
  let stopping = false;
  const stop = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal}: stopping the job queue`);
    queue
      .stop()
      .then(() => registry.close())
      .catch((error: unknown) => console.error(`stopping the job queue: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => process.exit(0));
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
