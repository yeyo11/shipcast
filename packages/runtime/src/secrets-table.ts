import { randomBytes } from 'node:crypto';
import type { SecretRows } from '@shipcast/engine';
import { seal, unseal, type Sealed } from './seal.ts';
import { SecretStoreError, type SecretStore } from './secrets.ts';

/** A secret as the table holds it, opened, with the version a compare-and-set names */
export interface VersionedSecret {
  value: string;
  version: number;
}

const pack = (s: Sealed) => `${s.iv}.${s.tag}.${s.data}`;
function unpack(text: string): Sealed {
  const [iv, tag, data] = text.split('.');
  if (!iv || !tag || data === undefined) throw new SecretStoreError('a sealed secret is malformed');
  return { iv, tag, data };
}

/**
 * Secrets in the registry's Postgres, one row each (docs/plans/performance-refactor.md, phase 5):
 * every replica of the app and every worker reads and writes the same rows, and a write changes one
 * row atomically, so no process can lose another's write. Each value is sealed with a data key of its
 * own, and the data key with the master key (SHIPCAST_SECRETS_KEY), which only the environment holds:
 * a dump of the database alone opens nothing. Writes bump `version`; `compareAndSet` writes only over
 * the version the caller read, for a refresh that must not overwrite another replica's.
 */
export class TableStore implements SecretStore {
  readonly kind = 'the registry’s encrypted secrets table';
  readonly #rows: SecretRows;
  readonly #master: Buffer;

  constructor(rows: SecretRows, masterKey: Buffer) {
    if (masterKey.length !== 32) throw new SecretStoreError('the secrets key must be 32 bytes (SHIPCAST_SECRETS_KEY: openssl rand -base64 32)');
    this.#rows = rows;
    this.#master = masterKey;
  }

  #seal(key: string, value: string, label: string) {
    const dataKey = randomBytes(32);
    return { key, label, sealed: pack(seal(dataKey, value)), sealedKey: pack(seal(this.#master, dataKey)) };
  }

  #open(row: { key: string; sealed: string; sealedKey: string }): string {
    try {
      const dataKey = unseal(this.#master, unpack(row.sealedKey));
      return unseal(dataKey, unpack(row.sealed)).toString('utf8');
    } catch (error) {
      if (error instanceof SecretStoreError) throw error;
      throw new SecretStoreError(`the secret ${row.key} does not open with this SHIPCAST_SECRETS_KEY`);
    }
  }

  async read(key: string): Promise<VersionedSecret | undefined> {
    const row = await this.#rows.get(key);
    return row ? { value: this.#open(row), version: row.version } : undefined;
  }

  async get(key: string): Promise<string | undefined> {
    return (await this.read(key))?.value;
  }

  async set(key: string, value: string, label = ''): Promise<void> {
    await this.#rows.put(this.#seal(key, value, label));
  }

  /**
   * Writes only if the secret is still at `version` (0: only if absent): what a token refresh does
   * inside its lock, so a value another replica wrote meanwhile is never overwritten. False when it
   * lost.
   */
  compareAndSet(key: string, value: string, version: number, label = ''): Promise<boolean> {
    return this.#rows.putIfVersion(this.#seal(key, value, label), version);
  }

  async delete(key: string): Promise<void> {
    await this.#rows.delete(key);
  }

  /** Every key held, for a migration's read-back and the app's list; never the values */
  keys(): Promise<string[]> {
    return this.#rows.keys();
  }
}

/** A store whose keys can be listed: the source of a copy into the table */
export interface ListableStore extends SecretStore {
  keys(): Promise<string[]>;
}

/**
 * Copies every secret of `from` into the table and reads each one back, so a copy that lost or
 * changed a value is caught before anything uses the table. `from` is only read: it stays as it was,
 * read-only from then on, until the table is verified in use. A key already in the table with a
 * different value is reported and left alone, never overwritten.
 */
export async function copySecrets(from: ListableStore, to: TableStore): Promise<{ copied: string[]; same: string[]; conflicts: string[] }> {
  const copied: string[] = [];
  const same: string[] = [];
  const conflicts: string[] = [];
  for (const key of await from.keys()) {
    const value = await from.get(key);
    if (value === undefined) continue;
    const there = await to.read(key);
    if (there) {
      (there.value === value ? same : conflicts).push(key);
      continue;
    }
    await to.set(key, value);
    if ((await to.get(key)) !== value) throw new SecretStoreError(`${key}: the copy does not read back as the original`);
    copied.push(key);
  }
  return { copied, same, conflicts };
}
