/**
 * Copies an install's secrets from the desktop keychain into the encrypted file a server reads
 * (SHIPCAST_SECRET_STORE=file), once, on the machine that holds the keychain:
 *
 *   SHIPCAST_SECRETS_KEY=$(openssl rand -base64 32) node scripts/keychain-to-file.ts <out/secrets.enc>
 *
 * Lists every entry of the install's keychain service (SHIPCAST_KEYCHAIN_SERVICE, `shipcast` by
 * default) with `secret-tool search`, reads each value as stored with `secret-tool lookup` (a
 * search prints multi-line values ambiguously) and writes them all to the file with the same
 * FileStore the server opens. Only the keys' names are printed, never a value. The key travels to
 * the server apart from the file, in its .env.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { FileStore, KeychainStore } from '../packages/runtime/src/secrets.ts';

const root = resolve(import.meta.dirname, '..');
if (existsSync(resolve(root, '.env'))) process.loadEnvFile(resolve(root, '.env'));

const out = process.argv[2];
const key = process.env.SHIPCAST_SECRETS_KEY?.trim();
if (!out || !key) {
  console.error('usage: SHIPCAST_SECRETS_KEY=<base64 32 bytes> node scripts/keychain-to-file.ts <out/secrets.enc>');
  process.exit(2);
}
if (existsSync(out)) {
  console.error(`${out} exists: move it away first, nothing is merged into an existing file`);
  process.exit(1);
}

const service = process.env.SHIPCAST_KEYCHAIN_SERVICE?.trim() || 'shipcast';
const search = spawnSync('secret-tool', ['search', '--all', '--unlock', 'service', service], { encoding: 'utf8' });
if (search.status !== 0) {
  console.error(`secret-tool search failed: ${search.stderr.trim() || `exit ${search.status}`}`);
  process.exit(1);
}
// `secret-tool search` writes the attributes to stdout and some versions to stderr: read both
const keys = [...new Set([...`${search.stdout}\n${search.stderr}`.matchAll(/^attribute\.key = (.+)$/gm)].map((m) => m[1]!.trim()))].sort();
if (keys.length === 0) {
  console.error(`no entries for service "${service}" in the keychain`);
  process.exit(1);
}

const keychain = new KeychainStore(service);
const file = new FileStore(resolve(out), Buffer.from(key, 'base64'));
let copied = 0;
for (const name of keys) {
  const value = await keychain.get(name);
  if (value === undefined) {
    console.warn(`skipped ${name}: listed but not readable`);
    continue;
  }
  await file.set(name, value, name);
  copied++;
  console.log(`copied ${name}`);
}
console.log(`${copied} of ${keys.length} secrets of "${service}" in ${resolve(out)}`);
