import {
  checkout,
  Claudio,
  GitHubApp,
  GitHubRest,
  loadBrand,
  Registry,
  type AiProvider,
  type ObjectRequest,
  type PipelineDeps,
  type TextRequest,
} from '@shipcast/engine';
import type { Brand } from '@shipcast/schema';
import { aiSetup } from './ai.ts';
import { loadConfig, type Config } from './config.ts';
import { GitHubUserTokens } from './github-user.ts';
import { KeychainStore, type SecretStore } from './secrets.ts';
import { importEnvSettings, RuntimeSettings } from './settings.ts';

/** How the engine reaches GitHub, for `shipcast status` and the Settings page */
export type GitHubAccess = { kind: 'app'; slug: string | undefined; bot: string | undefined } | { kind: 'token' };

/** What the app and the CLI both build at start, from the bootstrap alone */
export interface Runtime {
  config: Config;
  registry: Registry;
  secrets: SecretStore;
  settings: RuntimeSettings;
  /** The engine's GitHub client: the App's installation token, or the old personal token without an App */
  github: GitHubRest;
  githubApp: GitHubApp | undefined;
  access: GitHubAccess;
  /** The owner's user token from the last sign-in through the App; absent without an App */
  userTokens: GitHubUserTokens | undefined;
  pipeline: PipelineDeps;
  /** The brand the launches repo speaks for, read again every few minutes; SettingMissing without a launches repo */
  brand(): Promise<Brand>;
  /** Reads the settings again: after a save in the app, and before each round */
  refresh(): Promise<void>;
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
  registry?: Registry;
  fetch?: typeof fetch;
  /**
   * The fetch of the GitHub REST client alone, over `fetch`: a preview's dry run of the writes to
   * repos. Not the App's token minting or the sign-in, whose POSTs must stay real to read at all.
   */
  githubFetch?: typeof fetch;
}

const BRAND_TTL_MS = 5 * 60_000;

export async function createRuntime(options: RuntimeOptions): Promise<Runtime> {
  const env = options.env ?? process.env;
  const log = options.log ?? (() => undefined);
  const config = loadConfig(env, options.root);
  const registry = options.registry ?? (await Registry.connect(config.databaseUrl));
  const secrets = options.secrets ?? new KeychainStore(config.keychainService);
  const settings = new RuntimeSettings({ registry, secrets, env });

  const { imported, skipped } = await importEnvSettings({ registry, secrets, env });
  if (imported.length > 0) log(`Settings: imported ${imported.join(', ')} from .env into the settings and the keychain, once; .env stays a fallback until you remove them`);
  if (skipped.length > 0) log(`Settings: not imported from .env, the value does not pass the Settings page's check: ${skipped.join(', ')}`);
  await settings.read();

  const app = config.githubApp;
  const githubApp = app
    ? new GitHubApp({
        appId: app.appId,
        clientId: app.clientId,
        privateKey: app.privateKey,
        // The launches repo's installation; before one is set, the owner's own account
        account: () => settings.current().launchesRepo ?? config.allowedLogins[0],
        ...(options.fetch && { fetch: options.fetch }),
      })
    : undefined;
  const githubFetch = options.githubFetch ?? options.fetch;
  const github = new GitHubRest({ token: githubApp ?? config.githubToken!, ...(githubFetch && { fetch: githubFetch }) });
  const access: GitHubAccess = app ? { kind: 'app', slug: app.slug, bot: app.slug ? `${app.slug}[bot]` : undefined } : { kind: 'token' };
  const userTokens = app ? new GitHubUserTokens({ secrets, client: { clientId: app.clientId, clientSecret: app.clientSecret, ...(options.fetch && { fetch: options.fetch }) } }) : undefined;

  let cached: { repo: string; brand: Brand; at: number } | undefined;
  const brand = async (): Promise<Brand> => {
    const repo = settings.launchesRepo();
    if (!cached || cached.repo !== repo || Date.now() - cached.at > BRAND_TTL_MS) cached = { repo, brand: await loadBrand(github, repo), at: Date.now() };
    return cached.brand;
  };

  const pipeline: PipelineDeps = {
    github,
    ai: new SettingsClaudio(settings, options.fetch),
    aiSetup: aiSetup({
      env,
      registry,
      secrets,
      claudio: () => settings.claudio(),
      brand,
      ...(options.fetch && { fetch: options.fetch }),
    }),
    registry,
    // Getters: the engine reads them as plain values, and they follow the settings. Empty while
    // unset; every way into the pipeline reads the brand first, which says what is missing
    get launchesRepo() {
      return settings.current().launchesRepo ?? '';
    },
    get maxBudgetUsd() {
      return settings.current().maxBudgetUsd;
    },
    checkout: (repo, ref) => checkout({ hostDir: config.workspaceHostDir, providerDir: config.workspaceProviderDir }, repo, ref),
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
    brand,
    refresh: async () => {
      await settings.read();
    },
  };
}
