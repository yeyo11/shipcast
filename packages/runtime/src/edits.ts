import { readFileSync } from 'node:fs';
import { GitHubDiscussions, type GitHubTokenSource } from '@shipcast/connectors';
import { PostRefused, type CommentDeps, type EditDeps, type Editors, type Registry } from '@shipcast/engine';
import type { Brand, Channel } from '@shipcast/schema';
import { buildConnector, credentialsFromEnv, MissingField, NETWORKS, type Built, type Credentials } from './catalog.ts';
import { getJson, type SecretStore } from './secrets.ts';
import { accountSecretKey, envBrand, INSTAGRAM_TOKEN_KEY } from './services.ts';

export interface EditorDeps {
  env: NodeJS.ProcessEnv;
  brand: Brand;
  registry: Registry;
  secrets: SecretStore;
  readFile?: (path: string) => string;
  fetch?: typeof fetch;
  /** The engine's GitHub access, for GitHub Discussions, which has no account of its own */
  github?: { auth: GitHubTokenSource };
}

/** GitHub Discussions with the engine's GitHub access; undefined without it */
function discussions(deps: EditorDeps): GitHubDiscussions | undefined {
  return deps.github ? new GitHubDiscussions({ auth: deps.github.auth, ...(deps.fetch && { fetch: deps.fetch }) }) : undefined;
}

/**
 * A channel's connector built with the account a piece went out with, or the `.env` credentials for
 * a piece with none (undefined when `.env` has none, or speaks for another brand). An account that
 * is gone, or has lost its secrets, is refused with that reason.
 */
export async function postConnector(deps: EditorDeps, channel: Channel, accountId: number | null): Promise<Built | undefined> {
  const network = NETWORKS.find((n) => n.channel === channel);
  if (!network) return undefined;
  let credentials: Credentials | undefined;
  if (accountId !== null) {
    const account = await deps.registry.account(accountId);
    const secrets = account ? await getJson(deps.secrets, accountSecretKey(account.id)) : undefined;
    if (!account || !secrets) throw new PostRefused('no_credentials', `the ${network.name} account the post went out with is not connected any more`);
    credentials = { settings: account.settings, secrets };
  } else if (deps.brand.id === envBrand(deps.env)) {
    credentials = credentialsFromEnv(network.id, deps.env, deps.brand, deps.readFile ?? ((path) => readFileSync(path, 'utf8')));
    // A token Shipcast refreshed while it still came from .env lives in the registry, as publishing reads it
    const fresh = network.id === 'instagram' && credentials ? await deps.registry.cursor(INSTAGRAM_TOKEN_KEY) : undefined;
    if (credentials && fresh) credentials = { ...credentials, secrets: { ...credentials.secrets, accessToken: fresh } };
  }
  if (!credentials) return undefined;
  try {
    return buildConnector(network.id, credentials, deps.brand, deps.fetch);
  } catch (error) {
    if (error instanceof MissingField) throw new PostRefused('no_credentials', `${network.name}: ${error.message}`);
    throw error;
  }
}

/**
 * The connectors that read and answer a post's comments, with the account it went out with, for
 * the same reason as an edit: another account cannot reply as the one that posted.
 */
export function commentConnectors(deps: EditorDeps): CommentDeps['connectors'] {
  return async (channel, accountId) => {
    if (channel === 'githubDiscussions') {
      const connector = discussions(deps);
      return connector ? { reader: connector, replier: connector } : {};
    }
    const built = await postConnector(deps, channel, accountId);
    const connector = built?.mastodon ?? built?.bluesky ?? built?.instagram ?? built?.threads ?? built?.devto;
    if (!connector) return {};
    // dev.to reads only: Forem has no endpoint to write a comment
    return 'reply' in connector ? { reader: connector, replier: connector } : { reader: connector };
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
    if (channel === 'githubDiscussions') {
      const connector = discussions(deps);
      return connector ? { githubDiscussions: connector } : {};
    }
    const built = await postConnector(deps, channel, accountId);
    if (!built) return {};
    const editors: Editors = {
      ...(built.mastodon && { mastodon: built.mastodon }),
      ...(built.telegram && { telegram: built.telegram }),
      ...(built.discord && { discord: built.discord }),
      ...(built.devto && { devto: built.devto }),
      ...(built.hashnode && { hashnode: built.hashnode }),
      ...(built.bluesky && { bluesky: built.bluesky }),
      ...(built.threads && { threads: built.threads }),
      ...(built.linkedin && { linkedin: built.linkedin }),
    };
    return editors;
  };
}
