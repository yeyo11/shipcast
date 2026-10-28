import type { Repositories } from '@shipcast/engine';
import { InvalidRequest, ShipcastError } from '@shipcast/schema';
import type { SecretStore } from './secrets.ts';

/**
 * The settings: everything Shipcast needs that is not the bootstrap. Public values are rows of the
 * registry's `settings` table, secrets are keychain entries; both are read when needed, so the app
 * starts and signs in without any of them, and a change in the Settings page applies to what runs next.
 */
export interface SettingsValues {
  /** The repo whose blog and drafts the engine writes to, `owner/name` */
  launchesRepo: string | undefined;
  claudioUrl: string | undefined;
  claudioToken: string | undefined;
  /** Spend ceiling for one generation, in dollars */
  maxBudgetUsd: number | undefined;
  /** The Instagram app, for Instagram Login from the Channels page */
  instagramAppId: string | undefined;
  instagramAppSecret: string | undefined;
  /** The Threads use case of the owner's Meta app, for Threads' sign-in from the Channels page */
  threadsAppId: string | undefined;
  threadsAppSecret: string | undefined;
  /** The owner's LinkedIn app (Sign In with LinkedIn using OpenID Connect and Share on LinkedIn) */
  linkedinClientId: string | undefined;
  linkedinClientSecret: string | undefined;
  /** The owner's Reddit app, a "web app" whose API access Reddit has approved */
  redditClientId: string | undefined;
  redditClientSecret: string | undefined;
}

export type SettingName = keyof SettingsValues;

interface Definition {
  /** The `.env` variable it came from before, read as a fallback and imported once */
  env: string;
  /** Where it is kept: a row of `settings`, or a keychain entry */
  store: { kind: 'setting'; key: string } | { kind: 'secret'; key: string; label: string };
  label: string;
  /** Says what is wrong with a value, or nothing when it is fine */
  check?: (value: string) => string | undefined;
}

export const SETTINGS: Record<SettingName, Definition> = {
  launchesRepo: {
    env: 'SHIPCAST_LAUNCHES_REPO',
    store: { kind: 'setting', key: 'launches-repo' },
    label: 'The launches repo',
    check: (v) => (/^[\w.-]+\/[\w.-]+$/.test(v) ? undefined : `the launches repo must be owner/name, not "${v}"`),
  },
  claudioUrl: {
    env: 'SHIPCAST_CLAUDIO_URL',
    store: { kind: 'setting', key: 'claudio-url' },
    label: 'claudio’s URL',
    check: (v) => (/^https?:\/\/[^\s]+$/.test(v) ? undefined : `claudio’s URL must be http(s)://…, not "${v}"`),
  },
  claudioToken: { env: 'SHIPCAST_CLAUDIO_TOKEN', store: { kind: 'secret', key: 'app:claudio-token', label: 'claudio token' }, label: 'claudio’s token' },
  maxBudgetUsd: {
    env: 'SHIPCAST_MAX_BUDGET_USD',
    store: { kind: 'setting', key: 'ai-budget-usd' },
    label: 'The AI budget per generation',
    check: (v) => (Number(v) > 0 ? undefined : 'the AI budget must be a positive number of dollars'),
  },
  instagramAppId: { env: 'INSTAGRAM_APP_ID', store: { kind: 'setting', key: 'instagram-app-id' }, label: 'The Instagram app id' },
  instagramAppSecret: {
    env: 'INSTAGRAM_APP_SECRET',
    store: { kind: 'secret', key: 'app:instagram-app-secret', label: 'Instagram app secret' },
    label: 'The Instagram app secret',
  },
  threadsAppId: { env: 'THREADS_APP_ID', store: { kind: 'setting', key: 'threads-app-id' }, label: 'The Threads app id' },
  threadsAppSecret: {
    env: 'THREADS_APP_SECRET',
    store: { kind: 'secret', key: 'app:threads-app-secret', label: 'Threads app secret' },
    label: 'The Threads app secret',
  },
  linkedinClientId: { env: 'LINKEDIN_CLIENT_ID', store: { kind: 'setting', key: 'linkedin-client-id' }, label: 'The LinkedIn client id' },
  linkedinClientSecret: {
    env: 'LINKEDIN_CLIENT_SECRET',
    store: { kind: 'secret', key: 'app:linkedin-client-secret', label: 'LinkedIn client secret' },
    label: 'The LinkedIn client secret',
  },
  redditClientId: { env: 'REDDIT_CLIENT_ID', store: { kind: 'setting', key: 'reddit-client-id' }, label: 'The Reddit client id' },
  redditClientSecret: {
    env: 'REDDIT_CLIENT_SECRET',
    store: { kind: 'secret', key: 'app:reddit-client-secret', label: 'Reddit client secret' },
    label: 'The Reddit client secret',
  },
};

const NAMES = Object.keys(SETTINGS) as SettingName[];

/** A setting a page or a job needs and nobody set: the message says which one and where to set it */
export class SettingMissing extends ShipcastError {
  readonly setting: SettingName;

  constructor(setting: SettingName, what = SETTINGS[setting].label) {
    // Nothing wrong with the request: the app is not set up for it yet, until the owner sets it
    super(`${what} is not set: set it in Settings (/settings)`, { code: 'setting_missing', httpStatus: 409 });
    this.setting = setting;
  }
}

export class InvalidSetting extends InvalidRequest {}

export interface SettingsDeps {
  registry: Pick<Repositories, 'settings'>;
  secrets: SecretStore;
  /** `.env`, a fallback until the owner removes what was imported from it */
  env: NodeJS.ProcessEnv;
}

/** Where a value comes from, for the Settings page */
export type Source = 'settings' | 'keychain' | '.env' | 'unset';

const envValue = (env: NodeJS.ProcessEnv, name: SettingName) => env[SETTINGS[name].env]?.trim() || undefined;

async function stored(deps: SettingsDeps, name: SettingName): Promise<string | undefined> {
  const store = SETTINGS[name].store;
  if (store.kind === 'secret') return (await deps.secrets.get(store.key))?.trim() || undefined;
  const value = await deps.registry.settings.setting<string | number>(store.key);
  return value === undefined || value === null || value === '' ? undefined : String(value);
}

function parse(values: Partial<Record<SettingName, string>>): SettingsValues {
  const budget = values.maxBudgetUsd === undefined ? undefined : Number(values.maxBudgetUsd);
  return {
    launchesRepo: values.launchesRepo,
    claudioUrl: values.claudioUrl?.replace(/\/+$/, ''),
    claudioToken: values.claudioToken,
    maxBudgetUsd: budget !== undefined && budget > 0 ? budget : undefined,
    instagramAppId: values.instagramAppId,
    instagramAppSecret: values.instagramAppSecret,
    threadsAppId: values.threadsAppId,
    threadsAppSecret: values.threadsAppSecret,
    linkedinClientId: values.linkedinClientId,
    linkedinClientSecret: values.linkedinClientSecret,
    redditClientId: values.redditClientId,
    redditClientSecret: values.redditClientSecret,
  };
}

/**
 * The settings of one process. `read()` goes to the database and the keychain; `current()` is the
 * last read, for the places that need a value synchronously (the engine's `launchesRepo`). The app
 * reads again after a save, and every process before each round, so a change made in the app
 * reaches `shipcast watch` within one round.
 */
export class RuntimeSettings {
  readonly #deps: SettingsDeps;
  #current: SettingsValues = parse({});
  #sources: Record<SettingName, Source> = Object.fromEntries(NAMES.map((n) => [n, 'unset'])) as Record<SettingName, Source>;

  constructor(deps: SettingsDeps) {
    this.#deps = deps;
  }

  async read(): Promise<SettingsValues> {
    const raw: Partial<Record<SettingName, string>> = {};
    const sources = { ...this.#sources };
    for (const name of NAMES) {
      const own = await stored(this.#deps, name);
      const fallback = envValue(this.#deps.env, name);
      raw[name] = own ?? fallback;
      sources[name] = own !== undefined ? (SETTINGS[name].store.kind === 'secret' ? 'keychain' : 'settings') : fallback !== undefined ? '.env' : 'unset';
    }
    this.#current = parse(raw);
    this.#sources = sources;
    return this.#current;
  }

  current(): SettingsValues {
    return this.#current;
  }

  sources(): Record<SettingName, Source> {
    return this.#sources;
  }

  /** The settings that are still unset, by label, for `shipcast status` and the pages */
  missing(): SettingName[] {
    const required: SettingName[] = ['launchesRepo', 'claudioUrl', 'claudioToken'];
    return required.filter((n) => this.#current[n] === undefined);
  }

  launchesRepo(): string {
    const repo = this.#current.launchesRepo;
    if (!repo) throw new SettingMissing('launchesRepo');
    return repo;
  }

  claudio(): { url: string; token: string } {
    const { claudioUrl, claudioToken } = this.#current;
    if (!claudioUrl) throw new SettingMissing('claudioUrl');
    if (!claudioToken) throw new SettingMissing('claudioToken');
    return { url: claudioUrl, token: claudioToken };
  }

  /**
   * Saves what changed: a string sets the value, `null` clears it (and the value from `.env`, if any,
   * shows again), a missing key is left as it is. Every value is checked before any is saved.
   */
  async write(change: Partial<Record<SettingName, string | null>>): Promise<SettingsValues> {
    for (const name of NAMES) {
      const value = change[name];
      if (typeof value !== 'string') continue;
      const problem = value.trim() ? SETTINGS[name].check?.(value.trim()) : undefined;
      if (problem) throw new InvalidSetting(problem);
    }
    for (const name of NAMES) {
      const value = change[name];
      if (value === undefined) continue;
      await put(this.#deps, name, typeof value === 'string' && value.trim() ? value.trim() : undefined);
    }
    return this.read();
  }
}

async function put(deps: SettingsDeps, name: SettingName, value: string | undefined): Promise<void> {
  const store = SETTINGS[name].store;
  if (store.kind === 'secret') {
    if (value === undefined) await deps.secrets.delete(store.key);
    else await deps.secrets.set(store.key, value, store.label);
    return;
  }
  await deps.registry.settings.setSetting(store.key, name === 'maxBudgetUsd' && value !== undefined ? Number(value) : (value ?? ''));
}

/** The `.env` names imported already: a value cleared in the app afterwards is not brought back by the next start */
export const IMPORTED_KEY = 'settings-imported-from-env';

/**
 * The one-time import for an install that predates the settings: each value still in `.env` and not
 * yet in the settings or the keychain is copied there. Run at every start; a name is imported once
 * (and remembered), so running it again does nothing and an edit or a clear made in the app is never
 * undone. A value that would not pass the Settings page's check is left in `.env`. The names come
 * back, never the values, for the log.
 */
export async function importEnvSettings(deps: SettingsDeps): Promise<{ imported: string[]; skipped: string[] }> {
  const done = new Set((await deps.registry.settings.setting<string[]>(IMPORTED_KEY)) ?? []);
  const before = done.size;
  const imported: string[] = [];
  const skipped: string[] = [];
  for (const name of NAMES) {
    const variable = SETTINGS[name].env;
    const value = envValue(deps.env, name);
    if (value === undefined || done.has(variable)) continue;
    if (SETTINGS[name].check?.(value)) {
      skipped.push(variable);
      continue;
    }
    if ((await stored(deps, name)) === undefined) {
      await put(deps, name, value);
      imported.push(variable);
    }
    done.add(variable);
  }
  if (done.size !== before) await deps.registry.settings.setSetting(IMPORTED_KEY, [...done].sort());
  return { imported, skipped };
}
