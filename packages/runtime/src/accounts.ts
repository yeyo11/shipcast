import type { Check } from '@shipcast/connectors';
import type { Account, Registry } from '@shipcast/engine';
import type { Brand } from '@shipcast/schema';
import { buildConnector, credentialsFromEnv, MissingField, network, NETWORKS, type Credentials } from './catalog.ts';
import { getJson, type SecretStore } from './secrets.ts';
import { accountSecretKey, envBrand } from './services.ts';

/** What connecting, checking and editing accounts needs */
export interface AccountDeps {
  registry: Registry;
  secrets: SecretStore;
  /** Every brand Shipcast speaks for, by id: an account belongs to one of them */
  brands: Map<string, Brand>;
  fetch?: typeof fetch;
}

export type Connected = { ok: true; account: Account } | { ok: false; problem: string };

function brandOf(deps: AccountDeps, id: string): Brand {
  const brand = deps.brands.get(id);
  if (!brand) throw new MissingField(`no brand "${id}"`);
  return brand;
}

/** Splits a submitted form by the network's fields: secret values go to the keychain, the rest to the registry */
export function splitFields(networkId: string, values: Record<string, string>): Credentials {
  const settings: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  for (const field of network(networkId)?.fields ?? []) {
    const value = values[field.key]?.trim() ?? '';
    if (!value && !field.optional) throw new MissingField(`${field.label} is required`);
    if (field.secret) secrets[field.key] = value;
    else settings[field.key] = value;
  }
  return { settings, secrets };
}

async function check(networkId: string, credentials: Credentials, brand: Brand, http: typeof fetch | undefined): Promise<Check> {
  try {
    return await buildConnector(networkId, credentials, brand, http).check();
  } catch (error) {
    return { ok: false, problem: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Connects an account: the credential is checked first and only kept when it works, so the Channels
 * page never lists an account that could not post. Its secrets go to the keychain.
 */
export async function connectAccount(
  deps: AccountDeps,
  input: { network: string; brand: string; label?: string; credentials: Credentials },
): Promise<Connected> {
  const info = network(input.network);
  if (!info || info.auth === 'none') return { ok: false, problem: `${input.network} cannot be connected` };
  const brand = brandOf(deps, input.brand);
  const result = await check(input.network, input.credentials, brand, deps.fetch);
  if (!result.ok) return result;
  const label = input.label?.trim() || result.account;
  const existing = deps.registry.accounts({ brand: input.brand, network: input.network }).find((a) => a.label === label);
  // Connecting the same account again (a new token, a reconnection) updates it instead of failing
  const account = existing
    ? deps.registry.updateAccount(existing.id, { settings: input.credentials.settings })
    : deps.registry.addAccount({ network: input.network, brand: input.brand, label, settings: input.credentials.settings });
  await deps.secrets.set(accountSecretKey(account.id), JSON.stringify(input.credentials.secrets), `${info.name} ${label}`);
  return { ok: true, account: deps.registry.recordCheck(account.id, result) };
}

/** Checks a connected account again and records the answer */
export async function checkAccount(deps: AccountDeps, id: number): Promise<Account> {
  const account = deps.registry.account(id);
  if (!account) throw new MissingField(`no account ${id}`);
  const secrets = await getJson(deps.secrets, accountSecretKey(id));
  const result: Check = secrets
    ? await check(account.network, { settings: account.settings, secrets }, brandOf(deps, account.brand), deps.fetch)
    : { ok: false, problem: `its secrets are missing from ${deps.secrets.kind}: connect it again` };
  return deps.registry.recordCheck(id, result);
}

/** Disconnects an account: its row and its keychain entry both go */
export async function disconnectAccount(deps: AccountDeps, id: number): Promise<void> {
  await deps.secrets.delete(accountSecretKey(id));
  deps.registry.deleteAccount(id);
}

/**
 * Moves the credentials `.env` holds into connected accounts of the brand it speaks for, each checked
 * like any other. Networks that already have an account for that brand are left as they are.
 */
export async function importFromEnv(
  deps: AccountDeps,
  env: NodeJS.ProcessEnv,
  readFile: (path: string) => string,
): Promise<Array<{ network: string; result: Connected }>> {
  const brandId = envBrand(env);
  const brand = deps.brands.get(brandId);
  if (!brand) return [];
  const results: Array<{ network: string; result: Connected }> = [];
  for (const info of NETWORKS) {
    if (info.auth === 'none' || deps.registry.accounts({ brand: brandId, network: info.id }).length > 0) continue;
    if (info.id === 'github') continue; // the engine's own token stays in .env: it is what Shipcast runs on
    let credentials: Credentials | undefined;
    try {
      credentials = credentialsFromEnv(info.id, env, brand, readFile);
    } catch {
      continue;
    }
    if (credentials) results.push({ network: info.id, result: await connectAccount(deps, { network: info.id, brand: brandId, credentials }) });
  }
  return results;
}
