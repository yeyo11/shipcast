import { readFileSync } from 'node:fs';
import { ConnectorError, PostGone, type GitHubTokenSource, type IdentityCache } from '@shipcast/connectors';
import { PostRefused, type CommentConnectors, type CommentDeps, type EditDeps, type Editors, type Repositories } from '@shipcast/engine';
import type { Brand, Channel } from '@shipcast/schema';
import { buildConnector, credentialsFromEnv, network } from './catalog.ts';
import { MissingField, networkOf, type AnyChannelAdapter, type Credentials } from './channels/adapter.ts';
import { adapterOf } from './channels/registry.ts';
import type { TokenBucket } from './redis/ports.ts';
import { getJson, type SecretStore } from './secrets.ts';
import { accountSecretKey, envBrand, withRefreshedEnvToken } from './services.ts';

export interface EditorDeps {
  env: NodeJS.ProcessEnv;
  brand: Brand;
  registry: Pick<Repositories, 'accounts' | 'cursors'>;
  secrets: SecretStore;
  readFile?: (path: string) => string;
  fetch?: typeof fetch;
  /** The engine's GitHub access, for GitHub Discussions, which has no account of its own */
  github?: { auth: GitHubTokenSource };
  /** The channels' adapters; the registry's by default */
  adapters?: readonly AnyChannelAdapter[];
  buckets?: TokenBucket;
  /** Where accounts' identities are kept between runs (the comment feeds); without it each connector asks again */
  cache?: IdentityCache;
}

/**
 * A channel's connector built with the account a piece went out with, or the `.env` credentials for
 * a piece with none (undefined when `.env` has none, or speaks for another brand), else the brand's
 * one account of the network when it has exactly one (soleAccount); the engine's own
 * GitHub access for a channel that has no account. An account that is gone, or has lost its
 * secrets, is refused with that reason.
 */
export async function postConnector(deps: EditorDeps, channel: Channel, accountId: number | null): Promise<{ adapter: AnyChannelAdapter; connector: unknown; standIn?: StandIn } | undefined> {
  const adapter = adapterOf(channel, deps.adapters);
  if (!adapter) return undefined;
  if (adapter.connect.kind === 'engine') {
    return deps.github ? { adapter, connector: adapter.connect.build({ auth: deps.github.auth, fetch: deps.fetch }) } : undefined;
  }
  const spec = networkOf(adapter)!;
  const name = network(spec.id)?.name ?? adapter.definition.name;
  let credentials: Credentials | undefined;
  if (accountId !== null) {
    const account = await deps.registry.accounts.account(accountId);
    const secrets = account ? await getJson(deps.secrets, accountSecretKey(account.id)) : undefined;
    if (!account || !secrets) throw new PostRefused('no_credentials', `the ${name} account the post went out with is not connected any more`);
    credentials = { settings: account.settings, secrets };
  } else if (deps.brand.id === envBrand(deps.env)) {
    credentials = credentialsFromEnv(spec.id, deps.env, deps.brand, deps.readFile ?? ((path) => readFileSync(path, 'utf8')), deps.adapters);
    // A token Shipcast refreshed while it still came from .env lives in the registry, as publishing reads it
    if (credentials) credentials = await withRefreshedEnvToken(spec.id, credentials, deps.registry, deps.adapters);
  }
  let standIn: StandIn | undefined;
  if (!credentials && accountId === null) {
    const owns = OWNERSHIP[spec.id];
    const sole = owns ? await soleAccount(deps, spec.id, name) : undefined;
    if (owns && sole) {
      credentials = sole.credentials;
      standIn = { owns, refusal: `the ${name} account the post went out with was disconnected, and ${sole.label} cannot show the post is its own: assign the post an account` };
    }
  }
  if (!credentials) return undefined;
  try {
    const built = buildConnector(spec.id, credentials, deps.brand, deps.fetch, { ...(deps.adapters && { adapters: deps.adapters }), ...(deps.buckets && { buckets: deps.buckets }), ...(deps.cache && { cache: deps.cache }) });
    return { adapter, connector: built.connector, ...(standIn && { standIn }) };
  } catch (error) {
    if (error instanceof MissingField) throw new PostRefused('no_credentials', `${name}: ${error.message}`);
    throw error;
  }
}

/** An account standing in for a post's disconnected one: how it proves a post is its own, and what it says when it cannot */
export interface StandIn {
  owns(connector: unknown, externalId: string): Promise<boolean>;
  refusal: string;
}

/**
 * The networks where an account can prove a post is its own, so it may stand in for the post's
 * disconnected account: YouTube, by the video's channel. Elsewhere a 404 or another account's post
 * cannot be told apart (Mastodon answers 404 for another account's status, Discord for another
 * webhook's message), and a reply would go out as the wrong account, so nothing stands in.
 */
const OWNERSHIP: Partial<Record<string, StandIn['owns']>> = {
  youtube: (connection, id) => (connection as { youtube: { ownsVideo(id: string): Promise<boolean> } }).youtube.ownsVideo(id),
};

/**
 * A piece with no account and no `.env` credentials for its network: its account was disconnected
 * (the row's `account_id` is set to null when an account is removed). With exactly one account of
 * that network on the brand, that one may stand in, post by post once it shows the post is its own
 * (guarded); with several, any could be the wrong one, and the post needs an account assigned. With
 * none, there is nothing to read with (undefined).
 */
async function soleAccount(deps: EditorDeps, networkId: string, name: string): Promise<{ credentials: Credentials; label: string } | undefined> {
  const accounts = await deps.registry.accounts.accounts({ brand: deps.brand.id, network: networkId });
  if (accounts.length === 0) return undefined;
  if (accounts.length > 1) {
    throw new PostRefused('no_credentials', `the ${name} account the post went out with was disconnected, and the brand has ${accounts.length} ${name} accounts: assign the post an account`);
  }
  const account = accounts[0]!;
  const secrets = await getJson(deps.secrets, accountSecretKey(account.id));
  if (!secrets) throw new PostRefused('no_credentials', `the ${name} account the post went out with was disconnected, and ${account.label} has lost its secrets: connect it again`);
  return { credentials: { settings: account.settings, secrets }, label: account.label };
}

/**
 * A stand-in's reader, replier or editor: every call first shows the post is the account's (by the
 * post's id, its first argument or a reply target's `postExternalId`), and a 404 or a post gone is
 * never taken for the post being deleted, since it may be another account's.
 */
function guarded<T extends object>(target: T, connector: unknown, standIn: StandIn): T {
  return new Proxy(target, {
    get(object, key, receiver) {
      const value: unknown = Reflect.get(object, key, receiver);
      if (typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        const first = args[0];
        const id = typeof first === 'string' ? first : (first as { postExternalId?: unknown } | undefined)?.postExternalId;
        if (typeof id !== 'string' || !(await standIn.owns(connector, id))) throw new PostRefused('no_credentials', standIn.refusal);
        try {
          return await (value as (...a: unknown[]) => unknown).apply(object, args);
        } catch (error) {
          if (error instanceof PostGone || (error instanceof ConnectorError && error.status === 404)) throw new PostRefused('no_credentials', standIn.refusal);
          throw error;
        }
      };
    },
  });
}

/**
 * The connectors that read and answer a post's comments, with the account it went out with, for
 * the same reason as an edit: another account cannot reply as the one that posted. A stand-in has no
 * feed (a feed answers for many posts at once, which it cannot show are its own): its posts are read
 * one by one.
 */
export function commentConnectors(deps: EditorDeps): CommentDeps['connectors'] {
  return async (channel, accountId) => {
    const found = await postConnector(deps, channel, accountId);
    const connectors: CommentConnectors = found?.adapter.comments?.(found.connector) ?? {};
    const standIn = found?.standIn;
    if (!standIn) return connectors;
    return {
      ...(connectors.reader && { reader: guarded(connectors.reader, found.connector, standIn) }),
      ...(connectors.replier && { replier: guarded(connectors.replier, found.connector, standIn) }),
    };
  };
}

/**
 * The connectors that edit and delete a piece, built with the account it went out with. Publishing
 * takes a channel's primary account of the moment; an edit must not, since the primary may have
 * changed since and the other account cannot touch the post. A piece with no account went out with
 * the `.env` credentials, which only speak for their own brand.
 */
export function postEditors(deps: EditorDeps): EditDeps['editors'] {
  return async (channel, accountId) => {
    const found = await postConnector(deps, channel, accountId);
    const editor = found?.adapter.editor?.(found.connector);
    if (!found || !editor) return {};
    return { [channel]: found.standIn ? guarded(editor as object, found.connector, found.standIn) : editor } as Editors;
  };
}
