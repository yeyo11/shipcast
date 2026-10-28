import {
  checkout,
  Claudio,
  currentAiTexts,
  GitHubApp,
  GitHubRest,
  loadBrand,
  connectRepositories,
  DraftSnapshotService,
  PostgresLock,
  SecretRows,
  type OpenRepositories,
  type AiProvider,
  type AiTaskRunner,
  type ObjectRequest,
  type PipelineDeps,
  type TextRequest,
} from '@shipcast/engine';
import type { Brand } from '@shipcast/schema';
import { aiRunnerFor, aiSetup } from './ai.ts';
import { provisionAppKeys } from './app-keys.ts';
import { loadConfig, type Config } from './config.ts';
import { Flags } from './flags.ts';
import { poolOptions, roleFromEnv, split } from './roles.ts';
import { githubCaches, type GitHubCaches } from './github-events.ts';
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
  /** With `ai-runner`: the AI task runner every AI task runs on, through `pipeline.aiRunner` */
  aiRunner: AiTaskRunner | undefined;
  /** The brand the launches repo speaks for, read again every few minutes; SettingMissing without a launches repo */
  brand(): Promise<Brand>;
  /** Reads the settings again: after a save in the app, and before each round */
  refresh(): Promise<void>;
  /** Forgets the cached brand, so the next call reads it from the launches repo again */
  invalidateBrand(): void;
  /** With `github-events`: the GitHub client's ETag and file caches, which webhooks and the poll invalidate */
  githubCaches: GitHubCaches | undefined;
  /** With `github-events`: the drafts snapshots the launch page reads instead of GitHub */
  drafts: DraftSnapshotService | undefined;
  /** With `realtime-ui` and a bus: sends the registry's coalesced events still waiting, part of a stop */
  flushEvents(): Promise<void>;
}

/**
 * claudio as the settings have it when a request is made, so a URL or token changed in the app is
 * used by the next draft without a restart; missing ones fail that draft with where to set them.
 */
class SettingsClaudio implements AiProvider {
  readonly id = 'claudio' as const;
  readonly #settings: RuntimeSettings;
  readonly #fetch: typeof fetch | undefined;

  constructor(settings: RuntimeSettings, fetchImpl?: typeof fetch) {
    this.#settings = settings;
    this.#fetch = fetchImpl;
  }

  #claudio(): Claudio {
    return new Claudio({ ...this.#settings.claudio(), ...(this.#fetch && { fetch: this.#fetch }) });
  }

  generateObject(request: ObjectRequest) {
    return this.#claudio().generateObject(request);
  }

  streamText(request: TextRequest) {
    return this.#claudio().streamText(request);
  }
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
  /** The refactor's switches; read from `env` when not given */
  flags?: Flags;
  /**
   * The shared Cache (Redis, with `redis-state`) the GitHub caches live in, so every replica's 304
   * serves the others; this process's memory when not given
   */
  cache?: Cache;
  /**
   * The bus the registry's writes are announced on, with `realtime-ui` on (realtime/publish.ts): set
   * by a process that serves pages or works jobs, so every change a page shows reaches it
   */
  events?: EventBus;
}

const BRAND_TTL_MS = 5 * 60_000;

export async function createRuntime(options: RuntimeOptions): Promise<Runtime> {
  const env = options.env ?? process.env;
  const log = options.log ?? (() => undefined);
  const config = loadConfig(env, options.root);
  const flags = options.flags ?? Flags.fromEnv(env);
  const opened = options.registry ?? (await connectRepositories(config.databaseUrl, poolOptions(env)));
  // Wrapped before anything is built on it, so every writer below (the pipeline, the drafts, the jobs) announces
  const announced = flags.on('realtime-ui') && options.events ? withEvents(opened, options.events) : undefined;
  const registry = announced?.registry ?? opened;
  const secrets = options.secrets ?? secretStoreFor(config, env, { flags, rows: new SecretRows(registry.database) });
  // One session key and API pepper across replicas, read once per process (app-keys.ts)
  provisionAppKeys(secrets, { env, lock: new PostgresLock(registry.database) });
  const settings = new RuntimeSettings({ registry, secrets, env });

  const { imported, skipped } = await importEnvSettings({ registry, secrets, env });
  if (imported.length > 0) log(`Settings: imported ${imported.join(', ')} from .env into the settings and the keychain, once; .env stays a fallback until you remove them`);
  if (skipped.length > 0) log(`Settings: not imported from .env, the value does not pass the Settings page's check: ${skipped.join(', ')}`);
  await settings.read();

  const caches = flags.on('github-events') ? githubCaches(options.cache, () => settings.current().launchesRepo) : undefined;
  const app = config.githubApp;
  const githubApp = app
    ? new GitHubApp({
        appId: app.appId,
        clientId: app.clientId,
        privateKey: app.privateKey,
        // The launches repo's installation; before one is set, the owner's own account
        account: () => settings.current().launchesRepo ?? config.allowedLogins[0],
        ...(options.fetch && { fetch: options.fetch }),
        ...(caches && { etags: caches.etags }),
      })
    : undefined;
  const githubFetch = options.githubFetch ?? options.fetch;
  const github = new GitHubRest({ token: githubApp ?? config.githubToken!, ...(githubFetch && { fetch: githubFetch }), ...(caches && { etags: caches.etags, files: caches.files }) });
  const access: GitHubAccess = app ? { kind: 'app', slug: app.slug, bot: app.slug ? `${app.slug}[bot]` : undefined } : { kind: 'token' };
  // The refresh is locked across every process on the registry: two replicas never spend one refresh token
  const userTokens = app ? new GitHubUserTokens({ secrets, lock: new PostgresLock(registry.database), client: { clientId: app.clientId, clientSecret: app.clientSecret, ...(options.fetch && { fetch: options.fetch }) } }) : undefined;

  let cached: { repo: string; brand: Brand; at: number } | undefined;
  const brand = async (): Promise<Brand> => {
    const repo = settings.launchesRepo();
    // With the file cache brand.yml is read from GitHub once, then again only after a push to it
    if (caches) return loadBrand(github, repo);
    if (!cached || cached.repo !== repo || Date.now() - cached.at > BRAND_TTL_MS) cached = { repo, brand: await loadBrand(github, repo), at: Date.now() };
    return cached.brand;
  };

  const drafts = caches
    ? new DraftSnapshotService({
        github,
        registry,
        get launchesRepo() {
          return settings.current().launchesRepo ?? '';
        },
      })
    : undefined;

  // What choosing a task's provider needs, for the old providers and the runner alike
  const aiDeps = {
    env,
    registry,
    secrets,
    claudio: () => settings.claudio(),
    brand,
    ...(options.fetch && { fetch: options.fetch }),
  };
  const workspace = { hostDir: config.workspaceHostDir, providerDir: config.workspaceProviderDir };
  const recorder = telemetry();
  const aiRunner = flags.on('ai-runner') ? aiRunnerFor({ ...aiDeps, archives: github, ...(recorder && { telemetry: recorder }) }) : undefined;

  const pipeline: PipelineDeps = {
    github,
    ai: new SettingsClaudio(settings, options.fetch),
    aiSetup: aiSetup(aiDeps),
    registry,
    // Getters: the engine reads them as plain values, and they follow the settings. Empty while
    // unset; every way into the pipeline reads the brand first, which says what is missing
    get launchesRepo() {
      return settings.current().launchesRepo ?? '';
    },
    get maxBudgetUsd() {
      return settings.current().maxBudgetUsd;
    },
    // Beside other processes each job clones into a folder of its own, removed at its end
    checkout: (repo, ref) => checkout({ ...workspace, perJob: split(roleFromEnv(env)) }, repo, ref),
    ...(drafts && { drafts }),
    // With `ai-runner` the tasks run on the runner, with the owner's prompts and tone read before each
    ...(aiRunner && { aiRunner, aiTexts: () => currentAiTexts(registry) }),
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
    invalidateBrand: () => {
      cached = undefined;
    },
    githubCaches: caches,
    drafts,
    flushEvents: async () => {
      await announced?.flush();
    },
  };
}
