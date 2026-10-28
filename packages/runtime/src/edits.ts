import { readFileSync } from 'node:fs';
import type { GitHubTokenSource } from '@shipcast/connectors';
import { PostRefused, type CommentDeps, type EditDeps, type Editors, type Repositories } from '@shipcast/engine';
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
}

/**
 * A channel's connector built with the account a piece went out with, or the `.env` credentials for
 * a piece with none (undefined when `.env` has none, or speaks for another brand); the engine's own
 * GitHub access for a channel that has no account. An account that is gone, or has lost its
 * secrets, is refused with that reason.
 */
export async function postConnector(deps: EditorDeps, channel: Channel, accountId: number | null): Promise<{ adapter: AnyChannelAdapter; connector: unknown } | undefined> {
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
  if (!credentials) return undefined;
  try {
    const built = buildConnector(spec.id, credentials, deps.brand, deps.fetch, { ...(deps.adapters && { adapters: deps.adapters }), ...(deps.buckets && { buckets: deps.buckets }) });
    return { adapter, connector: built.connector };
  } catch (error) {
    if (error instanceof MissingField) throw new PostRefused('no_credentials', `${name}: ${error.message}`);
    throw error;
  }
}

/**
 * The connectors that read and answer a post's comments, with the account it went out with, for
 * the same reason as an edit: another account cannot reply as the one that posted.
 */
export function commentConnectors(deps: EditorDeps): CommentDeps['connectors'] {
  return async (channel, accountId) => {
    const found = await postConnector(deps, channel, accountId);
    return found?.adapter.comments?.(found.connector) ?? {};
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
    return editor ? ({ [channel]: editor } as Editors) : {};
  };
}
