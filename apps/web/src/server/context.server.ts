import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { GitHubApp, GitHubRest, PipelineDeps, Registry } from '@shipcast/engine';
import {
  buildServices,
  createRuntime,
  loadAppConfig,
  startWorking,
  WorkQueue,
  type AppConfig,
  type Config,
  type GitHubAccess,
  type GitHubUserTokens,
  type RuntimeSettings,
  type SecretStore,
  type WorkDeps,
} from '@shipcast/runtime';
import type { Brand } from '@shipcast/schema';
import { fakeNetworks, previewFetch, previewServices } from './preview.server';

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
  /** The bootstrap, from `.env` */
  config: Config;
  app: AppConfig;
  /** Everything else: the launches repo, claudio, the AI budget… read when needed */
  settings: RuntimeSettings;
  registry: Registry;
  github: GitHubRest;
  githubApp: GitHubApp | undefined;
  access: GitHubAccess;
  userTokens: GitHubUserTokens | undefined;
  secrets: SecretStore;
  deps: PipelineDeps;
  /** Reads the settings again, after the Settings page saved them */
  refresh(): Promise<void>;
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
  const app = loadAppConfig(process.env);
  const runtime = await createRuntime({ root: ROOT, log: console.log });
  const { config, registry, github, secrets, pipeline: deps, brand } = runtime;
  const queue = WorkQueue.postgres(config.databaseUrl, registry, { instanceName: 'app' });
  const work: WorkDeps = {
    env: process.env,
    registry,
    github,
    secrets,
    pipeline: deps,
    brand,
    refresh: runtime.refresh,
    // A preview with fake networks publishes nothing real, even a scheduled piece that comes due in it
    ...(fakeNetworks() && {
      services: async (b: Brand) => previewServices(await buildServices({ env: process.env, brand: b, registry, github, secrets, fetch: previewFetch })),
      fetch: previewFetch,
    }),
  };
  const ctx: AppContext = {
    config,
    app,
    settings: runtime.settings,
    registry,
    github,
    githubApp: runtime.githubApp,
    access: runtime.access,
    userTokens: runtime.userTokens,
    secrets,
    deps,
    refresh: runtime.refresh,
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
