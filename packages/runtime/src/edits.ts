import { readFileSync } from 'node:fs';
import { PostRefused, type EditDeps, type Editors, type Registry } from '@shipcast/engine';
import type { Brand } from '@shipcast/schema';
import { buildConnector, credentialsFromEnv, MissingField, NETWORKS, type Credentials } from './catalog.ts';
import { getJson, type SecretStore } from './secrets.ts';
import { accountSecretKey, envBrand } from './services.ts';

export interface EditorDeps {
  env: NodeJS.ProcessEnv;
  brand: Brand;
  registry: Registry;
  secrets: SecretStore;
  readFile?: (path: string) => string;
  fetch?: typeof fetch;
}

/**
 * The connectors that edit and delete a piece, built with the account it went out with. Publishing
 * takes a channel's primary account of the moment; an edit must not, since the primary may have
 * changed since and the other account cannot touch the post. A piece with no account went out with
 * the `.env` credentials, which only speak for their own brand.
 */
export function postEditors(deps: EditorDeps): EditDeps['editors'] {
  return async (channel, accountId) => {
    const network = NETWORKS.find((n) => n.channel === channel);
    if (!network) return {};
    let credentials: Credentials | undefined;
    if (accountId !== null) {
      const account = await deps.registry.account(accountId);
      const secrets = account ? await getJson(deps.secrets, accountSecretKey(account.id)) : undefined;
      if (!account || !secrets) throw new PostRefused('no_credentials', `the ${network.name} account the post went out with is not connected any more`);
      credentials = { settings: account.settings, secrets };
    } else if (deps.brand.id === envBrand(deps.env)) {
      credentials = credentialsFromEnv(network.id, deps.env, deps.brand, deps.readFile ?? ((path) => readFileSync(path, 'utf8')));
    }
    if (!credentials) return {};
    let built;
    try {
      built = buildConnector(network.id, credentials, deps.brand, deps.fetch);
    } catch (error) {
      if (error instanceof MissingField) throw new PostRefused('no_credentials', `${network.name}: ${error.message}`);
      throw error;
    }
    const editors: Editors = {
      ...(built.mastodon && { mastodon: built.mastodon }),
      ...(built.telegram && { telegram: built.telegram }),
      ...(built.discord && { discord: built.discord }),
      ...(built.devto && { devto: built.devto }),
      ...(built.hashnode && { hashnode: built.hashnode }),
      ...(built.bluesky && { bluesky: built.bluesky }),
    };
    return editors;
  };
}
