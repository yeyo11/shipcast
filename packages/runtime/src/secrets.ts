import { spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

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
    const decipher = createDecipheriv('aes-256-gcm', this.#key, Buffer.from(sealed.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
    let plain: string;
    try {
      plain = Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]).toString('utf8');
    } catch {
      throw new SecretStoreError(`${this.#path} does not open with this SHIPCAST_SECRETS_KEY`);
    }
    return new Map(Object.entries(JSON.parse(plain) as Record<string, string>));
  }

  async #write(values: Map<string, string>): Promise<void> {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(Object.fromEntries(values)), 'utf8'), cipher.final()]);
    const sealed = { v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
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

  set(key: string, value: string, _label?: string): Promise<void> {
    return this.#change((values) => values.set(key, value));
  }

  delete(key: string): Promise<void> {
    return this.#change((values) => values.delete(key));
  }
}

/**
 * The store an install uses: the desktop keychain by default, the encrypted file on a server
 * (SHIPCAST_SECRET_STORE=file, with SHIPCAST_SECRETS_KEY; the file is <data dir>/secrets.enc).
 */
export function secretStoreFor(config: { keychainService: string; dataDir: string }, env: NodeJS.ProcessEnv = process.env): SecretStore {
  const kind = env.SHIPCAST_SECRET_STORE?.trim() || 'keychain';
  if (kind === 'keychain') return new KeychainStore(config.keychainService);
  if (kind !== 'file') throw new SecretStoreError(`SHIPCAST_SECRET_STORE is "keychain" or "file", not "${kind}"`);
  const key = env.SHIPCAST_SECRETS_KEY?.trim();
  if (!key) throw new SecretStoreError('SHIPCAST_SECRET_STORE=file needs SHIPCAST_SECRETS_KEY (openssl rand -base64 32)');
  return new FileStore(join(config.dataDir, 'secrets.enc'), Buffer.from(key, 'base64'));
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
