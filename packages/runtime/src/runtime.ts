import {
  AppReviewService,
  archiveFolder,
  checkout,
  cloneInto,
  currentAiTexts,
  jobFolder,
  pageFetcher,
  GitHubApp,
  GitHubRest,
  inTransaction,
  loadBrand,
  connectRepositories,
  LaunchReadService,
  LaunchStoreService,
  PostgresLock,
  SecretRows,
  TriggerService,
  type OpenRepositories,
  type AiTaskRunner,
  type MediaStore,
  type PipelineDeps,
} from '@shipcast/engine';
import type { Brand } from '@shipcast/schema';
import { aiRunnerFor } from './ai.ts';
import { provisionAppKeys } from './app-keys.ts';
import { loadConfig, type Config } from './config.ts';
import { Flags } from './flags.ts';
import { poolOptions, roleFromEnv, split } from './roles.ts';
import { githubCaches, type GitHubCaches } from './github-events.ts';
import { mediaStoreFor } from './media.ts';
import { withEvents } from './realtime/publish.ts';
import type { Cache, EventBus } from './redis/ports.ts';
import { GitHubUserTokens } from './github-user.ts';
import { secretStoreFor, type SecretStore } from './secrets.ts';
import { importEnvSettings, RuntimeSettings } from './settings.ts';
import { telemetry } from './telemetry/fetch.ts';

/** How the engine reaches GitHub, for `shipcast status` and the Settings page */
export type GitHubAccess = { kind: 'app'; slug: string | undefined; bot: string | undefined } | { kind: 'token' };

/** What the app and the CLI both build at start, from the bootstrap alone */
export interface Runtime {
  config: Config;
  registry: OpenRepositories;
  secrets: SecretStore;
  settings: RuntimeSettings;
  /** The engine's GitHub client: the App's installation token, or the old personal token without an App */
  github: GitHubRest;
  githubApp: GitHubApp | undefined;
  access: GitHubAccess;
  /** The owner's user token from the last sign-in through the App; absent without an App */
  userTokens: GitHubUserTokens | undefined;
  pipeline: PipelineDeps;
  /** The AI task runner every AI task runs on, also `pipeline.aiRunner` */
  aiRunner: AiTaskRunner;
  /** The brand the launches repo speaks for, read again every few minutes; SettingMissing without a launches repo */
  brand(): Promise<Brand>;
  /** Reads the settings again: after a save in the app, and before each round */
  refresh(): Promise<void>;
  /** Kept for the replicas' events: the brand lives in the GitHub file cache, which pushes invalidate */
  invalidateBrand(): void;
  /** The GitHub client's ETag and file caches, which webhooks and the hourly poll invalidate */
  githubCaches: GitHubCaches;
  /** With a bus: sends the registry's coalesced events still waiting, part of a stop */
  flushEvents(): Promise<void>;
  /** Where launch media are kept (docs/media-store.md): R2 from SHIPCAST_MEDIA_* (media.ts) */
  media: MediaStore;
  /** The launch model's write: every launch's pack, channels, drafts and media in Shipcast's tables (docs/launch-store.md) */
  launchStore: LaunchStoreService;
  /** Launches read from the launch model's tables (docs/launch-store-read.md) */
  launchRead: LaunchReadService;
  /** Launches reviewed, approved and published from Shipcast, with no pull request (docs/app-review.md) */
  appReview: AppReviewService;
  /** The owner's trigger rules, which every claim of a GitHub event goes by (docs/launch-triggers.md) */
  triggers: TriggerService;
}

export interface RuntimeOptions {
  env?: NodeJS.ProcessEnv;
  root: string;
  /** Lines about the start (the one-time import), never with a value in them */
  log?: (line: string) => void;
  /** For tests: a keychain and a registry of their own */
  secrets?: SecretStore;
  registry?: OpenRepositories;
  fetch?: typeof fetch;
  /**
   * The fetch of the GitHub REST client alone, over `fetch`: a preview's dry run of the writes to
   * repos. Not the App's token minting or the sign-in, whose POSTs must stay real to read at all.
   */
  githubFetch?: typeof fetch;
  /** The switches still in use (SHIPCAST_FLAGS); read from `env` when not given */
  flags?: Flags;
  /**
   * The shared Cache (Redis) the GitHub caches live in, so every replica's 304 serves the others;
   * this process's memory when not given
   */
  cache?: Cache;
  /**
   * The bus the registry's writes are announced on (realtime/publish.ts): set by a process that
   * serves pages or works jobs, so every change a page shows reaches it
   */
  events?: EventBus;
  /** For tests: a media store of their own instead of the one SHIPCAST_MEDIA_* builds */
  media?: MediaStore;
}

export async function createRuntime(options: RuntimeOptions): Promise<Runtime> {
  const env = options.env ?? process.env;
  const log = options.log ?? (() => undefined);
  const config = loadConfig(env, options.root);
  // Read so an unknown name stops the start; no switch of the runtime's is left (umami is the services')
  void (options.flags ?? Flags.fromEnv(env));
  const opened = options.registry ?? (await connectRepositories(config.databaseUrl, poolOptions(env)));
  // Wrapped before anything is built on it, so every writer below (the pipeline, the drafts, the jobs) announces
  const announced = options.events ? withEvents(opened, options.events) : undefined;
  const registry = announced?.registry ?? opened;
  const secrets = options.secrets ?? secretStoreFor(config, env, { rows: new SecretRows(registry.database) });
  // One session key and API pepper across replicas, read once per process (app-keys.ts)
  provisionAppKeys(secrets, { env, lock: new PostgresLock(registry.database) });
  const settings = new RuntimeSettings({ registry, secrets, env });

  const { imported, skipped } = await importEnvSettings({ registry, secrets, env });
  if (imported.length > 0) log(`Settings: imported ${imported.join(', ')} from .env into the settings and the keychain, once; .env stays a fallback until you remove them`);
  if (skipped.length > 0) log(`Settings: not imported from .env, the value does not pass the Settings page's check: ${skipped.join(', ')}`);
  await settings.read();

  const caches = githubCaches(options.cache, () => settings.current().launchesRepo);
  const app = config.githubApp;
  const githubApp = app
    ? new GitHubApp({
        appId: app.appId,
        clientId: app.clientId,
        privateKey: app.privateKey,
        // The launches repo's installation; before one is set, the owner's own account
        account: () => settings.current().launchesRepo ?? config.allowedLogins[0],
        ...(options.fetch && { fetch: options.fetch }),
        etags: caches.etags,
      })
    : undefined;
  const githubFetch = options.githubFetch ?? options.fetch;
  const github = new GitHubRest({ token: githubApp ?? config.githubToken!, ...(githubFetch && { fetch: githubFetch }), etags: caches.etags, files: caches.files });
  const access: GitHubAccess = app ? { kind: 'app', slug: app.slug, bot: app.slug ? `${app.slug}[bot]` : undefined } : { kind: 'token' };
  // The refresh is locked across every process on the registry: two replicas never spend one refresh token
  const userTokens = app ? new GitHubUserTokens({ secrets, lock: new PostgresLock(registry.database), client: { clientId: app.clientId, clientSecret: app.clientSecret, ...(options.fetch && { fetch: options.fetch }) } }) : undefined;

  // With the file cache brand.yml is read from GitHub once, then again only after a push to it
  const brand = async (): Promise<Brand> => loadBrand(github, settings.launchesRepo());

  const media = options.media ?? mediaStoreFor(env, { ...(options.fetch && { fetch: options.fetch }) });
  const launchStore = new LaunchStoreService({
    registry,
    media,
    github,
    get launchesRepo() {
      return settings.current().launchesRepo ?? '';
    },
  });
  const launchRead = new LaunchReadService({ registry, media, site: async () => (await brand()).site });
  // Every new launch is held by Shipcast: no drafts pull request (docs/app-review.md)
  const appReview = new AppReviewService({
    registry,
    media,
    github,
    store: launchStore,
    get launchesRepo() {
      return settings.current().launchesRepo ?? '';
    },
  });
  const triggers = new TriggerService({ registry, inTransaction: (work) => inTransaction(registry, work) });
  // A release whose launch the owner removed is never launched again by its events (docs/launch-delete.md).
  // One indexed lookup (launch_deletions_by_key) per claim
  const removed = (dedupeKey: string) => registry.launchDeletions.removed(dedupeKey);

  // What choosing a task's provider needs: read when a task runs, so a change in the app applies to the next one
  const aiDeps = {
    env,
    registry,
    secrets,
    claudio: () => settings.claudio(),
    brand,
    ...(options.fetch && { fetch: options.fetch }),
  };
  const workspace = { hostDir: config.workspaceHostDir };
  const recorder = telemetry();
  const aiRunner = aiRunnerFor({ ...aiDeps, archives: github, ...(recorder && { telemetry: recorder }) });

  const pipeline: PipelineDeps = {
    github,
    // Every task runs on the runner, with the owner's prompts and tone read before each
    aiRunner,
    aiTexts: () => currentAiTexts(registry),
    registry,
    // Getters: the engine reads them as plain values, and they follow the settings. Empty while
    // unset; every way into the pipeline reads the brand first, which says what is missing
    get launchesRepo() {
      return settings.current().launchesRepo ?? '';
    },
    // Beside other processes each job clones into a folder of its own, removed at its end
    checkout: (repo, ref) => checkout({ ...workspace, perJob: split(roleFromEnv(env)) }, repo, ref),
    launchRead,
    appReview,
    // A launch made from sources, its bundle in a folder of the job's own
    sources: {
      store: registry.sources,
      launches: registry.launches,
      folder: (name: string) => jobFolder({ ...workspace, perJob: split(roleFromEnv(env)) }, name),
      clone: (repo: string, ref: string, hostPath: string, sha?: string) => cloneInto(workspace, repo, ref, hostPath, sha),
      archive: archiveFolder,
      fetchPage: pageFetcher(),
    },
    triggers,
    removed,
  };

  return {
    config,
    registry,
    secrets,
    settings,
    github,
    githubApp,
    access,
    userTokens,
    pipeline,
    aiRunner,
    brand,
    refresh: async () => {
      await settings.read();
    },
    // brand.yml is read through the file cache, which a push to it (or the hourly poll) forgets
    invalidateBrand: () => undefined,
    githubCaches: caches,
    flushEvents: async () => {
      await announced?.flush();
    },
    media,
    launchStore,
    launchRead,
    appReview,
    triggers,
  };
}
