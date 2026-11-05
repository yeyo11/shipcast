import { readAiSettings, type Repositories } from '@shipcast/engine';
import { InvalidRequest, ShipcastError } from '@shipcast/schema';
import { NETWORK_SPECS } from './catalog.ts';
import type { NetworkSpec, OAuthApp, OAuthSpec } from './channels/adapter.ts';
import { oauthSpecsOf } from './oauth-specs.ts';
import type { SecretStore } from './secrets.ts';

/**
 * The settings: everything Shipcast needs that is not the bootstrap. Public values are rows of the
 * registry's `settings` table, secrets are keychain entries; both are read when needed, so the app
 * starts and signs in without any of them, and a change in the Settings page applies to what runs next.
 */
interface BaseValues {
  /** The repo whose blog and drafts the engine writes to, `owner/name` */
  launchesRepo: string | undefined;
  claudioUrl: string | undefined;
  claudioToken: string | undefined;
  /** How the owner's Meta app signs in to Instagram: one of INSTAGRAM_LOGINS; unset is `instagram` */
  instagramLogin: string | undefined;
  /** The Facebook Login for Business configurations the Meta app signs in with, for Instagram and for Pages */
  instagramConfigId: string | undefined;
  facebookConfigId: string | undefined;
}

/** The Instagram setups a Meta app may have: Instagram Login, both logins, or Facebook Login for Business */
export const INSTAGRAM_LOGINS = ['instagram', 'unified', 'facebook'] as const;

/**
 * The owner's app on each network that signs in through one (its `oauth` spec in
 * packages/runtime/src/channels): `instagramAppId` and `instagramAppSecret`, `redditClientId` and
 * `redditClientSecret`, named by the app's id (a network's, or `meta` shared by several) and by how
 * the network names the app.
 */
export type OAuthSettingName = `${string}${'App' | 'Client'}${'Id' | 'Secret'}`;

export type SettingsValues = BaseValues & Partial<Record<OAuthSettingName, string>>;

export type SettingName = keyof BaseValues | OAuthSettingName;

interface Definition {
  /** The `.env` variable it came from before, read as a fallback and imported once */
  env: string;
  /** Where it is kept: a row of `settings`, or a keychain entry */
  store: { kind: 'setting'; key: string } | { kind: 'secret'; key: string; label: string };
  label: string;
  /** Says what is wrong with a value, or nothing when it is fine */
  check?: (value: string) => string | undefined;
  /** The only values it takes, which the Settings page offers as a list */
  choices?: readonly string[];
}

const TERMS = { app: 'App', client: 'Client' } as const;

const appSettingName = (app: OAuthSpec['app'], part: 'Id' | 'Secret'): OAuthSettingName => `${app.id}${TERMS[app.term]}${part}`;

/**
 * The two settings of each app the networks sign in with, its id public and its secret in the
 * keychain, from the networks' specs: an app several specs share (Meta's) is derived once.
 */
export function oauthAppSettings(networks: readonly NetworkSpec[] = NETWORK_SPECS): Record<OAuthSettingName, Definition> {
  const out: Record<string, Definition> = {};
  for (const network of networks) {
    for (const { app } of oauthSpecsOf(network)) {
      const id = appSettingName(app, 'Id');
      if (id in out) continue;
      const { term, name } = app;
      const env = `${app.id.toUpperCase()}_${term.toUpperCase()}`;
      out[id] = { env: `${env}_ID`, store: { kind: 'setting', key: `${app.id}-${term}-id` }, label: `The ${name} ${term} id` };
      out[appSettingName(app, 'Secret')] = {
        env: `${env}_SECRET`,
        store: { kind: 'secret', key: `app:${app.id}-${term}-secret`, label: `${name} ${term} secret` },
        label: `The ${name} ${term} secret`,
      };
    }
  }
  return out;
}

/** The setting of an app's id or secret, by the app's id: `instagramAppId`, `redditClientSecret`, `metaAppId` */
export function oauthSettingName(appId: string, part: 'Id' | 'Secret'): OAuthSettingName {
  const app = NETWORK_SPECS.flatMap(oauthSpecsOf).find((s) => s.app.id === appId)?.app;
  return appSettingName(app ?? { id: appId, term: 'client', name: appId }, part);
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
  // No single AI budget any more: each task's limit (DEFAULT_AI_BUDGETS_USD, or the owner's in the
  // `ai` settings row) is the only one. An install that set the old one keeps an `ai-budget-usd` row
  // and maybe SHIPCAST_MAX_BUDGET_USD in its env; neither is read, so both are left as they are.
  ...oauthAppSettings(),
  instagramLogin: {
    env: 'INSTAGRAM_LOGIN',
    store: { kind: 'setting', key: 'instagram-login' },
    label: 'The Instagram setup of the Meta app',
    choices: INSTAGRAM_LOGINS,
    check: (v) => ((INSTAGRAM_LOGINS as readonly string[]).includes(v) ? undefined : `the Instagram setup must be ${INSTAGRAM_LOGINS.join(', ')}, not "${v}"`),
  },
  // Not secrets: Meta says a configuration id identifies a configuration and gives no access
  instagramConfigId: { env: 'INSTAGRAM_CONFIG_ID', store: { kind: 'setting', key: 'instagram-config-id' }, label: 'The Instagram configuration id' },
  facebookConfigId: { env: 'FACEBOOK_CONFIG_ID', store: { kind: 'setting', key: 'facebook-config-id' }, label: 'The Facebook configuration id' },
};

const NAMES = Object.keys(SETTINGS) as SettingName[];

/**
 * A setting's definition. The networks' app settings are named by a pattern, which the type system
 * reads as an index (so possibly missing); every name the code uses comes from SETTINGS itself.
 */
export function settingDefinition(name: SettingName): Definition {
  const definition = SETTINGS[name];
  if (!definition) throw new InvalidSetting(`${name} is not a setting`);
  return definition;
}

/** A setting a page or a job needs and nobody set: the message says which one and where to set it */
export class SettingMissing extends ShipcastError {
  readonly setting: SettingName;

  constructor(setting: SettingName, what = settingDefinition(setting).label) {
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

const envValue = (env: NodeJS.ProcessEnv, name: SettingName) => env[settingDefinition(name).env]?.trim() || undefined;

async function stored(deps: SettingsDeps, name: SettingName): Promise<string | undefined> {
  const store = settingDefinition(name).store;
  if (store.kind === 'secret') return (await deps.secrets.get(store.key))?.trim() || undefined;
  const value = await deps.registry.settings.setting<string | number>(store.key);
  return value === undefined || value === null || value === '' ? undefined : String(value);
}

/** The settings that are not a network's app */
const BASE: Record<keyof BaseValues, true> = { launchesRepo: true, claudioUrl: true, claudioToken: true, instagramLogin: true, instagramConfigId: true, facebookConfigId: true };

function parse(values: Partial<Record<SettingName, string>>): SettingsValues {
  return {
    launchesRepo: values.launchesRepo,
    claudioUrl: values.claudioUrl?.replace(/\/+$/, ''),
    claudioToken: values.claudioToken,
    instagramLogin: values.instagramLogin,
    instagramConfigId: values.instagramConfigId,
    facebookConfigId: values.facebookConfigId,
    ...Object.fromEntries(NAMES.filter((n) => !(n in BASE)).map((n) => [n, values[n]])),
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
      sources[name] = own !== undefined ? (settingDefinition(name).store.kind === 'secret' ? 'keychain' : 'settings') : fallback !== undefined ? '.env' : 'unset';
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

  /**
   * The settings that are still unset, by label, for `shipcast status` and the pages. claudio's
   * address and token are needed only while a task of the AI settings runs on claudio: with the
   * Anthropic API or an OpenAI-compatible server chosen for every task, they are not missing
   * (`missingNow` reads that choice).
   */
  missing(options: { claudio?: boolean } = {}): SettingName[] {
    const required: SettingName[] = ['launchesRepo', ...(options.claudio === false ? [] : (['claudioUrl', 'claudioToken'] as const))];
    return required.filter((n) => this.#current[n] === undefined);
  }

  /** `missing`, knowing from the AI settings whether any task runs on claudio */
  async missingNow(): Promise<SettingName[]> {
    const ai = await readAiSettings(this.#deps.registry);
    return this.missing({ claudio: Object.values(ai.tasks).some((t) => t.provider === 'claudio') });
  }

  launchesRepo(): string {
    const repo = this.#current.launchesRepo;
    if (!repo) throw new SettingMissing('launchesRepo');
    return repo;
  }

  /**
   * The owner's app a sign-in uses; undefined until its id and secret are set, and its configuration
   * id when the spec names one
   */
  oauthApp(spec: OAuthSpec): OAuthApp | undefined {
    const clientId = this.#current[appSettingName(spec.app, 'Id')];
    const clientSecret = this.#current[appSettingName(spec.app, 'Secret')];
    if (!clientId || !clientSecret) return undefined;
    if (!spec.config) return { clientId, clientSecret };
    const configId = this.#current[spec.config];
    return configId ? { clientId, clientSecret, configId } : undefined;
  }

  /** What a sign-in still lacks, by the label of the first missing setting: the id, the secret, then the configuration id */
  missingFor(spec: OAuthSpec): string | undefined {
    const needed: SettingName[] = [appSettingName(spec.app, 'Id'), appSettingName(spec.app, 'Secret'), ...(spec.config ? [spec.config] : [])];
    const name = needed.find((n) => !this.#current[n]);
    // An app no network's spec derives has no definition: its setting's name is the best label there is
    return name === undefined ? undefined : (SETTINGS[name]?.label ?? name);
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
      const problem = value.trim() ? settingDefinition(name).check?.(value.trim()) : undefined;
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
  const store = settingDefinition(name).store;
  if (store.kind === 'secret') {
    if (value === undefined) await deps.secrets.delete(store.key);
    else await deps.secrets.set(store.key, value, store.label);
    return;
  }
  await deps.registry.settings.setSetting(store.key, value ?? '');
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
    const variable = settingDefinition(name).env;
    const value = envValue(deps.env, name);
    if (value === undefined || done.has(variable)) continue;
    if (settingDefinition(name).check?.(value)) {
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
