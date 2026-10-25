import { spawn } from 'node:child_process';

/**
 * Where secrets live: the operating system's keychain, so a token never sits in a file Shipcast
 * writes. Keys are Shipcast's own (`account:12`, `app:session-key`); values are opaque strings.
 */
export interface SecretStore {
  /** Which backend, for the app to say where secrets are kept */
  readonly kind: string;
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, label: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export class SecretStoreError extends Error {}

function run(command: string, args: string[], input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
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
    child.stdin.end(input ?? '');
  });
}

const SERVICE = 'shipcast';

/**
 * The desktop keychain through its own command-line tools, so there is no native module to build:
 * `secret-tool` (libsecret: GNOME Keyring, KWallet) on Linux, `security` on macOS. On Linux the value
 * goes through stdin; macOS's tool only takes it as an argument, briefly visible to the same user.
 */
export class KeychainStore implements SecretStore {
  readonly kind: string;
  readonly #platform: NodeJS.Platform;

  constructor(platform: NodeJS.Platform = process.platform) {
    if (platform !== 'linux' && platform !== 'darwin') throw new SecretStoreError(`no keychain support on ${platform}`);
    this.#platform = platform;
    this.kind = platform === 'linux' ? 'the desktop keyring (libsecret)' : 'the macOS keychain';
  }

  async get(key: string): Promise<string | undefined> {
    const result =
      this.#platform === 'linux'
        ? await run('secret-tool', ['lookup', 'service', SERVICE, 'key', key])
        : await run('security', ['find-generic-password', '-s', SERVICE, '-a', key, '-w']);
    if (result.code !== 0) return undefined;
    // `security` ends the value with a newline; secret-tool returns it as stored
    return this.#platform === 'darwin' ? result.stdout.replace(/\n$/, '') : result.stdout;
  }

  async set(key: string, value: string, label: string): Promise<void> {
    const result =
      this.#platform === 'linux'
        ? await run('secret-tool', ['store', `--label=Shipcast: ${label}`, 'service', SERVICE, 'key', key], value)
        : await run('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', key, '-l', `Shipcast: ${label}`, '-w', value]);
    if (result.code !== 0) throw new SecretStoreError(`could not save ${key} in ${this.kind}: ${result.stderr.trim() || `exit ${result.code}`}`);
  }

  async delete(key: string): Promise<void> {
    if (this.#platform === 'linux') await run('secret-tool', ['clear', 'service', SERVICE, 'key', key]);
    else await run('security', ['delete-generic-password', '-s', SERVICE, '-a', key]);
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
