import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SecretRows } from '@shipcast/engine';
import type { Flags } from './flags.ts';
import { seal, unseal } from './seal.ts';
import { TableStore } from './secrets-table.ts';

/**
 * Where secrets live: the operating system's keychain on a desktop, so a token never sits in a file
 * Shipcast writes; an encrypted file on a server (FileStore). Keys are Shipcast's own (`account:12`, `app:session-key`); values are opaque strings.
 */
export interface SecretStore {
  /** Which backend, for the app to say where secrets are kept */
  readonly kind: string;
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, label: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export class SecretStoreError extends Error {}

/** Runs a keychain tool; its exit code is the answer, so a tool that quits before reading its input is not an error */
export function run(command: string, args: string[], input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('error', (error: NodeJS.ErrnoException) =>
      reject(error.code === 'ENOENT' ? new SecretStoreError(`${command} is not installed`) : error),
    );
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    // A tool that exits before reading stdin (a locked keyring, a refused lookup) breaks the pipe; unhandled,
    // that EPIPE took the whole app down on 2026-10-27, so its exit code is what reports the failure
    child.stdin.on('error', () => undefined);
    child.stdin.end(input ?? '');
  });
}

/**
 * The desktop keychain through its own command-line tools, so there is no native module to build:
 * `secret-tool` (libsecret: GNOME Keyring, KWallet) on Linux, `security` on macOS. On Linux the value
 * goes through stdin; macOS's tool only takes it as an argument, briefly visible to the same user.
 */
export class KeychainStore implements SecretStore {
  readonly kind: string;
  readonly #platform: NodeJS.Platform;
  readonly #service: string;

  /** `service` is the bootstrap's SHIPCAST_KEYCHAIN_SERVICE: a second install (or a test copy) keeps its own entries */
  constructor(service = 'shipcast', platform: NodeJS.Platform = process.platform) {
    if (platform !== 'linux' && platform !== 'darwin') throw new SecretStoreError(`no keychain support on ${platform}`);
    this.#platform = platform;
    this.#service = service;
    this.kind = platform === 'linux' ? 'the desktop keyring (libsecret)' : 'the macOS keychain';
  }

  async get(key: string): Promise<string | undefined> {
    const result =
      this.#platform === 'linux'
        ? await run('secret-tool', ['lookup', 'service', this.#service, 'key', key])
        : await run('security', ['find-generic-password', '-s', this.#service, '-a', key, '-w']);
    if (result.code !== 0) return undefined;
    // `security` ends the value with a newline; secret-tool returns it as stored
    return this.#platform === 'darwin' ? result.stdout.replace(/\n$/, '') : result.stdout;
  }

  async set(key: string, value: string, label: string): Promise<void> {
    const result =
      this.#platform === 'linux'
        ? await run('secret-tool', ['store', `--label=Shipcast: ${label}`, 'service', this.#service, 'key', key], value)
        : await run('security', ['add-generic-password', '-U', '-s', this.#service, '-a', key, '-l', `Shipcast: ${label}`, '-w', value]);
    if (result.code !== 0) throw new SecretStoreError(`could not save ${key} in ${this.kind}: ${result.stderr.trim() || `exit ${result.code}`}`);
  }

  /**
   * The keys this service holds, never the values: what a copy into the table walks. Both tools print
   * the secrets too while listing; only the key attribute is read from their output, and nothing of
   * it is kept or shown.
   */
  async keys(): Promise<string[]> {
    const result =
      this.#platform === 'linux' ? await run('secret-tool', ['search', '--all', '--unlock', 'service', this.#service]) : await run('security', ['dump-keychain']);
    if (result.code !== 0 && this.#platform === 'darwin') throw new SecretStoreError(`could not list ${this.kind}: ${result.stderr.trim() || `exit ${result.code}`}`);
    const text = `${result.stdout}\n${result.stderr}`;
    if (this.#platform === 'linux') return [...new Set([...text.matchAll(/^attribute\.key = (.*)$/gm)].map((m) => m[1]!.trim()))];
    // `security dump-keychain` prints one block per item; the service is `svce` and the key is `acct`
    const keys = new Set<string>();
    for (const block of text.split(/^keychain: /m)) {
      const service = /"svce"<blob>="([^"]*)"/.exec(block)?.[1];
      const account = /"acct"<blob>="([^"]*)"/.exec(block)?.[1];
      if (service === this.#service && account) keys.add(account);
    }
    return [...keys];
  }

  async delete(key: string): Promise<void> {
    if (this.#platform === 'linux') await run('secret-tool', ['clear', 'service', this.#service, 'key', key]);
    else await run('security', ['delete-generic-password', '-s', this.#service, '-a', key]);
  }
}

/** For tests, and for a machine without a keychain where nothing should outlive the process */
export class MemoryStore implements SecretStore {
  readonly kind = 'memory';
  readonly #values = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.#values.get(key);
  }

  async set(key: string, value: string, _label?: string): Promise<void> {
    this.#values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.#values.delete(key);
  }

  async keys(): Promise<string[]> {
    return [...this.#values.keys()];
  }
}

/**
 * A server has no desktop keychain: the secrets live in one file, encrypted with AES-256-GCM under a
 * key that is not in it (SHIPCAST_SECRETS_KEY, 32 bytes in base64, in the environment). The file is
 * read on every call and replaced atomically on every write, so a CLI and the web app on the same
 * machine see each other's changes; writes within one process are serialised.
 */
export class FileStore implements SecretStore {
  readonly kind = 'an encrypted file';
  readonly #path: string;
  readonly #key: Buffer;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(path: string, key: Buffer) {
    if (key.length !== 32) throw new SecretStoreError('the secrets key must be 32 bytes (SHIPCAST_SECRETS_KEY: openssl rand -base64 32)');
    this.#path = path;
    this.#key = key;
  }

  async #read(): Promise<Map<string, string>> {
    let text: string;
    try {
      text = await readFile(this.#path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
      throw error;
    }
    const sealed = JSON.parse(text) as { v: number; iv: string; tag: string; data: string };
    if (sealed.v !== 1) throw new SecretStoreError(`${this.#path}: unknown format ${String(sealed.v)}`);
    let plain: string;
    try {
      plain = unseal(this.#key, sealed).toString('utf8');
    } catch {
      throw new SecretStoreError(`${this.#path} does not open with this SHIPCAST_SECRETS_KEY`);
    }
    return new Map(Object.entries(JSON.parse(plain) as Record<string, string>));
  }

  async #write(values: Map<string, string>): Promise<void> {
    const sealed = { v: 1, ...seal(this.#key, JSON.stringify(Object.fromEntries(values))) };
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    const temporary = `${this.#path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(sealed), { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, this.#path);
  }

  #change(apply: (values: Map<string, string>) => void): Promise<void> {
    const next = this.#queue.then(async () => {
      const values = await this.#read();
      apply(values);
      await this.#write(values);
    });
    this.#queue = next.catch(() => undefined);
    return next;
  }

  async get(key: string): Promise<string | undefined> {
    await this.#queue;
    return (await this.#read()).get(key);
  }

  /** The keys held, never the values: what a copy into another store walks */
  async keys(): Promise<string[]> {
    await this.#queue;
    return [...(await this.#read()).keys()];
  }

  set(key: string, value: string, _label?: string): Promise<void> {
    return this.#change((values) => values.set(key, value));
  }

  delete(key: string): Promise<void> {
    return this.#change((values) => values.delete(key));
  }
}

/** What the table store needs, which only a process with the registry open can give */
export interface TableStoreDeps {
  /** The refactor's switches: `table` is refused unless `secrets-table` is on */
  flags: Pick<Flags, 'on'>;
  /** The registry's `secrets` rows */
  rows: SecretRows;
}

/** The master key of the file and the table stores: 32 bytes in base64, only ever in the environment */
function masterKey(env: NodeJS.ProcessEnv, kind: string): Buffer {
  const key = env.SHIPCAST_SECRETS_KEY?.trim();
  if (!key) throw new SecretStoreError(`SHIPCAST_SECRET_STORE=${kind} needs SHIPCAST_SECRETS_KEY (openssl rand -base64 32)`);
  return Buffer.from(key, 'base64');
}

/**
 * The store an install uses: the desktop keychain by default, the encrypted file on a server
 * (SHIPCAST_SECRET_STORE=file, with SHIPCAST_SECRETS_KEY; the file is <data dir>/secrets.enc), or the
 * registry's encrypted `secrets` table (SHIPCAST_SECRET_STORE=table, with the same key and the
 * `secrets-table` flag), the one every replica and worker can share. `table` needs `table`: the rows,
 * from a process that has the registry open.
 */
export function secretStoreFor(config: { keychainService: string; dataDir: string }, env: NodeJS.ProcessEnv = process.env, table?: TableStoreDeps): SecretStore {
  const kind = env.SHIPCAST_SECRET_STORE?.trim() || 'keychain';
  if (kind === 'keychain') return new KeychainStore(config.keychainService);
  if (kind === 'file') return new FileStore(join(config.dataDir, 'secrets.enc'), masterKey(env, kind));
  if (kind !== 'table') throw new SecretStoreError(`SHIPCAST_SECRET_STORE is "keychain", "file" or "table", not "${kind}"`);
  // Off, the table is not selectable at all: turning the flag off goes back to the old store, never to a half-wired one
  if (table && !table.flags.on('secrets-table')) throw new SecretStoreError('SHIPCAST_SECRET_STORE=table needs the secrets-table flag (SHIPCAST_FLAGS=secrets-table)');
  if (!table) throw new SecretStoreError('SHIPCAST_SECRET_STORE=table is the registry’s table: this command does not open the registry');
  return new TableStore(table.rows, masterKey(env, kind));
}

/** Reads a JSON object kept under one key; a value that is not one is treated as absent */
export async function getJson(store: SecretStore, key: string): Promise<Record<string, string> | undefined> {
  const text = await store.get(key);
  if (!text) return undefined;
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, string>) : undefined;
  } catch {
    return undefined;
  }
}
