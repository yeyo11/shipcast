import { randomBytes } from 'node:crypto';
import type { SecretStore } from './secrets.ts';
import { TableStore } from './secrets-table.ts';

/*
 * The app's own keys: the session signing key and the API tokens' pepper. Made on first use and kept
 * in the secret store, they must be one value across every replica: two replicas making their own at
 * once would each sign sessions (or hash tokens) the other refuses. So, once a store is provisioned
 * (provisionAppKeys, which the runtime does for the app and the CLI):
 *
 * - a value in the environment wins (SHIPCAST_SESSION_KEY, SHIPCAST_API_TOKEN_PEPPER), for a
 *   deployment that provisions them in its bootstrap and never wants them made;
 * - otherwise the first maker wins: in the table by an insert-if-absent (compare-and-set at version
 *   0) and a read-back, elsewhere under a lock across processes (the registry's advisory lock);
 * - either way the value is read once per process and kept, so a request no longer costs a keychain
 *   call.
 *
 * A store nobody provisioned behaves as before: read, and made if missing, on every call.
 */

/** Where a deployment may provision each key instead of letting the first replica make it */
export const APP_KEY_ENV: Readonly<Record<string, string>> = {
  'app:session-key': 'SHIPCAST_SESSION_KEY',
  'app:api-token-pepper': 'SHIPCAST_API_TOKEN_PEPPER',
};

/** A lock across processes; the engine's PostgresLock is one */
export interface KeyLock {
  run<T>(key: string, work: () => Promise<T>): Promise<T>;
}

export interface AppKeyOptions {
  env?: NodeJS.ProcessEnv;
  lock?: KeyLock;
}

const provisioned = new WeakMap<SecretStore, { options: AppKeyOptions; cache: Map<string, Promise<string>> }>();

/** Makes `secrets` hand out the app's keys from the environment or created once, and cached */
export function provisionAppKeys(secrets: SecretStore, options: AppKeyOptions = {}): void {
  provisioned.set(secrets, { options, cache: new Map() });
}

const fresh = () => randomBytes(32).toString('base64url');

async function makeOnce(secrets: SecretStore, key: string, label: string, lock: KeyLock | undefined): Promise<string> {
  if (secrets instanceof TableStore) {
    const there = await secrets.get(key);
    if (there) return there;
    // Of two replicas inserting at once one row lands; both read back the one that did
    await secrets.compareAndSet(key, fresh(), 0, label);
    const value = await secrets.get(key);
    if (!value) throw new Error(`${key} was made but does not read back`);
    return value;
  }
  const make = async () => {
    const there = await secrets.get(key);
    if (there) return there;
    const value = fresh();
    await secrets.set(key, value, label);
    return value;
  };
  return lock ? lock.run(`app-key:${key}`, make) : make();
}

/** The value of one of the app's keys, as text (base64url of 32 bytes when Shipcast made it) */
export function appKey(secrets: SecretStore, key: string, label: string): Promise<string> {
  const state = provisioned.get(secrets);
  if (!state) return makeOnce(secrets, key, label, undefined);
  const variable = APP_KEY_ENV[key];
  const given = variable ? state.options.env?.[variable]?.trim() : undefined;
  if (given) return Promise.resolve(given);
  let value = state.cache.get(key);
  if (!value) {
    value = makeOnce(secrets, key, label, state.options.lock);
    // A failed read is not kept: the next call tries again
    value.catch(() => state.cache.delete(key));
    state.cache.set(key, value);
  }
  return value;
}
