import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { TelemetryStore, type GitHubApp, type GitHubRest, type PipelineDeps, type Repositories } from '@shipcast/engine';
import {
  attachTelemetryStore,
  buildServices,
  Flags,
  installTelemetry,
  type TelemetryRecorder,
  createRuntime,
  loadAppConfig,
  onStop,
  queuePoolMax,
  replicaEvents,
  roleFromEnv,
  runsTheClock,
  split,
  startMaintenance,
  startWorking,
  stopOnSignals,
  type AppConfig,
  type Config,
  type GitHubAccess,
  type GitHubUserTokens,
  type JobQueue,
  type Role,
  type RuntimeSettings,
  type SecretStore,
  type WorkDeps,
} from '@shipcast/runtime';
import { jobQueue } from '@shipcast/runtime/queue-factory';
import { processState, RedisLock, type EventName, type ProcessState, type ShipcastEvents } from '@shipcast/runtime/redis';
import type { Brand } from '@shipcast/schema';
import { fakeNetworks, previewFetch, previewGitHubFetch, previewServices } from './preview.server';

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
  registry: Repositories;
  github: GitHubRest;
  githubApp: GitHubApp | undefined;
  access: GitHubAccess;
  userTokens: GitHubUserTokens | undefined;
  secrets: SecretStore;
  deps: PipelineDeps;
  /** Reads the settings again, after the Settings page saved them */
  refresh(): Promise<void>;
  /**
   * After a save in Settings: this process reads the settings again, and with `redis-state` on every
   * other replica is told to (settings.changed)
   */
  settingsSaved(key?: string): Promise<void>;
  /** Tells every replica (with `redis-state` on), and this process, of a change they cache */
  announce<E extends EventName>(event: E, payload: ShipcastEvents[E]): Promise<void>;
  /** The durable work: pg-boss on the registry's Postgres, or BullMQ with `bullmq` on; worked here by the role's queues */
  queue: JobQueue;
  /** What this process takes on (SHIPCAST_ROLE) */
  role: Role;
  /** The shared ephemeral state and Redis connections of this process */
  process: ProcessState;
  /** The refactor's switches (SHIPCAST_FLAGS), one per phase that changes behaviour */
  flags: Flags;
  /** The measurement: outbound calls, server functions, requests and jobs, counted per hour */
  telemetry: TelemetryRecorder;
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
  // First, so the clients built below take the counting fetch
  const telemetry = installTelemetry('web');
  const flags = Flags.fromEnv(process.env);
  const role = roleFromEnv(process.env);
  const app = loadAppConfig(process.env);
  const proc = processState(process.env, role === 'all' ? 'app' : role);
  // A preview's GitHub client reads for real and only pretends to write: no pull request, commit or merge
  const runtime = await createRuntime({ root: ROOT, log: console.log, ...(fakeNetworks() && { githubFetch: previewGitHubFetch() }) });
  const { config, registry, github, secrets, pipeline: deps, brand } = runtime;
  attachTelemetryStore(new TelemetryStore(registry.database));
  const clock = runsTheClock(role);
  /*
   * One process (`all`) does what it always did: pg-boss's cron and maintenance, and the rows
   * reconciled at its start. In a split only the worker runs pg-boss's cron and maintenance, and no
   * start reconciles: the worker does, under a lock (startMaintenance)
   */
  const queue = jobQueue({
    flags,
    registry,
    databaseUrl: config.databaseUrl,
    redis: proc.redis,
    options: { instanceName: role === 'all' ? 'app' : role, telemetry, schedule: clock, supervise: clock, reconcileAtStart: !split(role), poolMax: queuePoolMax(process.env) },
  });
  const work: WorkDeps = {
    env: process.env,
    registry,
    github,
    secrets,
    pipeline: deps,
    brand,
    refresh: runtime.refresh,
    flags,
    // A preview with fake networks publishes nothing real, even a scheduled piece that comes due in it
    ...(fakeNetworks() && {
      services: async (b: Brand) => previewServices(await buildServices({ env: process.env, brand: b, registry, github, secrets, fetch: previewFetch })),
      fetch: previewFetch,
    }),
  };
  // Another replica's save, the App's installation and the brand reach this process's caches
  const events = await replicaEvents(proc.shared, runtime);
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
    settingsSaved: events.settingsSaved,
    announce: events.announce,
    queue,
    role,
    process: proc,
    flags,
    telemetry,
    brand,
    brands: async () => {
      const b = await brand();
      return new Map([[b.id, b]]);
    },
  };
  // The steps of a stop, in their phases (lifecycle.ts): the HTTP server's own is main.ts's
  onStop('queue', 'the job queue', () => queue.stop());
  onStop('telemetry', 'the telemetry', () => telemetry.stop());
  onStop('redis', 'Redis', () => proc.close());
  onStop('db', 'the registry', () => registry.close());
  stopOnSignals(process.env);

  // The web role only sends work; every other works its own queues (all of them for `all`)
  if (role !== 'web') {
    const { probePages } = await import('./probe.server');
    await startWorking(queue, work, { role, handlers: { probe: (_data, job) => probePages(ctx, job) } });
    // Beside other processes, or on BullMQ whose scheduled posts are rebuilt from Postgres: under a lock, every ten minutes
    if (clock && (split(role) || flags.on('bullmq'))) {
      // Redis's lock whenever Redis is there, so workers never run it twice at once even without redis-state
      const lock = proc.redis ? new RedisLock(proc.redis.queue) : proc.shared.lock;
      const stop = startMaintenance({ queue, lock, reconcileRows: split(role) });
      onStop('queue', 'the maintenance', async () => stop());
    }
  }
  return ctx;
}
