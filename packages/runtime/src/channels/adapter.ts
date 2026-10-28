import type { Check, GitHubTokenSource, IdentityCache, Profile, ProfileEdit, ProfileStats } from '@shipcast/connectors';
import type { CommentConnectors, Editors, MetricSources, Publishers, PublishStrategy } from '@shipcast/engine';
import type { Brand, Channel, ChannelDefinition } from '@shipcast/schema';
import type { TokenBucket } from '../redis/ports.ts';

/*
 * The adapter half of a channel (docs/plans/performance-refactor.md, "One definition per channel"):
 * what reaching its network takes, which the pure definition in packages/schema/src/channels cannot
 * hold since the domain does no I/O. One module per channel in this folder, listed in registry.ts
 * under the definition's id; the catalog, the services, the editors, the OAuth flows, the token
 * refreshes and the Action's secrets are all derived from them. The networks that are not channels
 * (the measurement sources, the AI providers) are `NetworkSpec`s of the catalog with no definition.
 */

/** A value an account needs: public ones are kept in the registry, secret ones in the keychain. */
export interface Field {
  key: string;
  label: string;
  secret: boolean;
  optional?: boolean;
  placeholder?: string;
  help?: string;
  /** A pasted file, such as a service account's JSON key */
  multiline?: boolean;
}

/** What an account is made of when it is built: its public settings and its secrets together. */
export interface Credentials {
  settings: Record<string, string>;
  secrets: Record<string, string>;
}

export class MissingField extends Error {}

/** What building one account's connector is given */
export interface BuildContext {
  /** A value the connector cannot do without, from the settings or the secrets; MissingField when empty */
  need(key: string): string;
  /** A value it can do without; undefined when empty */
  get(key: string): string | undefined;
  brand: Brand;
  fetch: typeof fetch | undefined;
  /** The per-provider budgets every process shares (redis/ports.ts), for a network with a quota to keep under */
  buckets: TokenBucket | undefined;
  /** Where the account's identity (its id, username, a read session) is kept between runs, when the process has a cache */
  cache: IdentityCache | undefined;
}

/** One account's connector, and what every network's offers whatever its channel: its check and its account */
export interface Connection<C = unknown> {
  connector: C;
  check(): Promise<Check>;
  /** The account's own followers, following and posts, on the networks whose API counts them */
  profileStats?(): Promise<ProfileStats>;
  /** The account's own profile, on the networks whose API gives it */
  profile?(): Promise<Profile>;
  /** Changes the profile, on the networks whose API allows it */
  editProfile?(edit: ProfileEdit): Promise<void>;
  /** The hours the account's followers are online, where the network says (Instagram) */
  audienceHours?(): Promise<{ timeZone: string; hours: number[] } | undefined>;
}

/**
 * One `.env` variable of a network: how Shipcast was configured before the app, still the fallback for
 * the brand `.env` speaks for, and what Action mode publishes with (its secrets are named the same).
 */
export interface EnvVariable {
  name: string;
  /** The credential it fills */
  key: string;
  secret: boolean;
  /** Left empty, the credential is built without it (`''`); else the network has no `.env` credentials */
  optional?: boolean;
  /** Where the value comes from when the variable is not set: the brand's profile links */
  fallback?(brand: Brand): string | undefined;
  /** It names a file, whose content is the value (a service account's JSON key) */
  file?: boolean;
  /** The Action's secret when it is not this name: a file arrives as its text */
  actionName?: string;
  /** Not one of the Action's secrets for the channel: an extra the owner may add */
  notInAction?: boolean;
  /** Where to get it, as `shipcast init` lists it */
  how?: string;
}

/** The owner's app on a network, as Settings keeps it */
export interface OAuthApp {
  clientId: string;
  clientSecret: string;
}

/**
 * A sign-in through the network's own consent page, with the owner's app (its id and secret in
 * Settings), at `/auth/<network>` and `/auth/<network>/callback`. Mastodon has none of these: it
 * registers itself on each instance.
 */
export interface OAuthSpec {
  /** How the network names the app (Meta: "app id" and "app secret"; the others, "client id" and "client secret") */
  app: { term: 'app' | 'client'; name: string };
  authorizeUrl(app: OAuthApp, redirectUri: string, state: string): string;
  /** The code the callback got, as the account's credentials and, when the network says, its label */
  exchange(app: OAuthApp, redirectUri: string, code: string, http?: typeof fetch): Promise<{ label?: string; credentials: Credentials }>;
  /** The callback's query parameters that explain a refusal, the most useful first */
  errorParams: readonly string[];
}

/** A token that lasts some weeks and is refreshed before it runs out, where it is kept */
export interface TokenRefresh {
  /** How old a token may get before it is refreshed */
  everyMs: number;
  /** The connector that refreshes one account's token; undefined when the account lacks what it needs */
  refresher(settings: Record<string, string>, accessToken: string, http?: typeof fetch): { refreshToken(): Promise<{ accessToken: string; expiresIn: number }> } | undefined;
  /** Where a token refreshed while it still came from `.env` is kept, in the registry, never in a file */
  envToken?: { tokenKey: string; refreshedKey: string };
}

/** A network an account is connected for: the Channels page's card, its form or its sign-in, and its connector */
export interface NetworkSpec<C = unknown> {
  /** The account's network, as `accounts.network` keeps it */
  id: string;
  auth: 'oauth' | 'form';
  /** What the form asks; for OAuth, what is asked before leaving for the network (the instance) */
  fields: Field[];
  /** What Shipcast does with the account, in words */
  permissions: string[];
  /** Where the credential comes from */
  howTo: string;
  env?: readonly EnvVariable[];
  oauth?: OAuthSpec;
  refresh?: TokenRefresh;
  /** Builds the connector; a missing value throws MissingField, so an account is never half-built */
  build(context: BuildContext): Connection<C>;
}

/** A network that is not a channel: a source of numbers, or an AI provider */
export interface SourceSpec<C = unknown> extends NetworkSpec<C> {
  name: string;
  /** Whether it reads numbers for the dashboard */
  metrics: boolean;
  /** An AI provider the AI settings can choose */
  ai?: boolean;
  /** Where its connector goes in the metric sources, and the name `shipcast status` says it by */
  source?: { slot: 'blog' | 'search' | 'bing'; configured: string };
}

/** What a channel's connector is wired as, for the engine's ports; each one only where the network has it */
type Wired<T> = T extends undefined ? never : T;
type PublisherOf<Id> = Id extends keyof Publishers ? Wired<Publishers[Id]> : unknown;
type EditorOf<Id> = Id extends keyof Editors ? Wired<Editors[Id]> : unknown;
export type PostMetricReader = Wired<Wired<MetricSources['posts']>[Channel]>;

export interface ChannelAdapter<C = unknown, Id extends string = string, P = PublisherOf<Id>> {
  /** The channel's pure half: its names, its capabilities, its piece of the pack */
  definition: ChannelDefinition<Id>;
  /**
   * How it is reached: an account the owner connects (whose network may be named otherwise, the
   * newsletter's is Brevo), or the engine's own GitHub access, which no account stands for
   */
  connect: { kind: 'account'; network: NetworkSpec<C>; provider?: string } | { kind: 'engine'; build(deps: { auth: GitHubTokenSource; fetch: typeof fetch | undefined }): C; configured: string };
  /** Whether the brand can publish on it at all: the newsletter needs brand.yml's lists */
  usable?(brand: Brand): boolean;
  /** The connector as the engine's publisher for the channel */
  publisher(connector: C): P;
  /** How the engine publishes it, for a channel it has no run built in for (BUILT_IN_PUBLISHING) */
  strategy?: PublishStrategy<P>;
  /** As the engine's editor and deleter of a published piece, where the network edits or deletes */
  editor?(connector: C): EditorOf<Id>;
  /** As a reader of a published piece's numbers */
  metrics?(connector: C): PostMetricReader;
  /** As the reader of a post's comments, and the replier where the network takes replies */
  comments?(connector: C): CommentConnectors;
  /** As the bot that tells the owner what is waiting, in the owner's own chat; undefined when none is set */
  notifier?(connection: Connection<C>, credentials: Credentials, http: typeof fetch | undefined): { notify(text: string): Promise<unknown> } | undefined;
}

/**
 * A channel's adapter, checked against the engine's ports for its id: a built-in channel's publisher
 * and editor must be what the engine calls, a new channel's publisher what its strategy takes.
 */
export function channelAdapter<Id extends string, C, P = PublisherOf<Id>>(adapter: ChannelAdapter<C, Id, P>): ChannelAdapter<C, Id, P> {
  return adapter;
}

/**
 * Any channel's adapter, as the registry holds them: the connector and the publisher differ per
 * channel, and the registry only hands one to the other (the methods take them bivariantly)
 */
export type AnyChannelAdapter = ChannelAdapter<unknown, string, unknown>;

/** The network an adapter's accounts are of, when it has accounts */
export function networkOf(adapter: AnyChannelAdapter): NetworkSpec | undefined {
  return adapter.connect.kind === 'account' ? adapter.connect.network : undefined;
}

/** A required credential value, or MissingField saying which one */
export function need(values: Record<string, string>, key: string, network: string): string {
  const value = values[key]?.trim();
  if (!value) throw new MissingField(`${network} needs ${key}`);
  return value;
}

/** The context a connector is built in, over one account's credentials */
export function buildContext(network: string, credentials: Credentials, brand: Brand, http: typeof fetch | undefined, buckets?: TokenBucket, cache?: IdentityCache): BuildContext {
  const all = { ...credentials.settings, ...credentials.secrets };
  return { need: (key) => need(all, key, network), get: (key) => all[key] || undefined, brand, fetch: http, buckets, cache };
}

/**
 * A network's `.env` credentials from its variables: undefined unless every required one is set (or
 * has a fallback in the brand); an optional one left unset is `''`.
 */
export function envCredentials(variables: readonly EnvVariable[], env: NodeJS.ProcessEnv, brand: Brand, readFile: (path: string) => string): Credentials | undefined {
  const credentials: Credentials = { settings: {}, secrets: {} };
  for (const variable of variables) {
    const raw = env[variable.name]?.trim() ? env[variable.name]! : variable.fallback?.(brand);
    if (!raw) {
      if (!variable.optional) return undefined;
      (variable.secret ? credentials.secrets : credentials.settings)[variable.key] = '';
      continue;
    }
    (variable.secret ? credentials.secrets : credentials.settings)[variable.key] = variable.file ? readFile(raw) : raw;
  }
  return credentials;
}
