import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, test } from 'node:test';
import { FileStore, KeychainStore, run, SecretStoreError, secretStoreFor } from '../src/secrets.ts';

test('a tool that exits before reading its input answers with its exit code, not an EPIPE', async () => {
  // More than a pipe's buffer, so the write is still pending when the tool exits
  const result = await run('false', [], 'x'.repeat(4 * 1024 * 1024));
  assert.equal(result.code, 1);
});

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'shipcast-secrets-'));
}

describe('FileStore', () => {
  it('keeps values across instances, encrypted and mode 600', async () => {
    const dir = await scratch();
    const path = join(dir, 'secrets.enc');
    const key = randomBytes(32);
    await new FileStore(path, key).set('account:12', '{"token":"s3cr3t"}', 'Bluesky');
    const reopened = new FileStore(path, key);
    assert.equal(await reopened.get('account:12'), '{"token":"s3cr3t"}');
    assert.equal(await reopened.get('missing'), undefined);
    const raw = await readFile(path, 'utf8');
    assert.ok(!raw.includes('s3cr3t'), 'the value is not in the file in clear');
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  });

  it('deletes, and an absent file reads as empty', async () => {
    const dir = await scratch();
    const store = new FileStore(join(dir, 'nested', 'secrets.enc'), randomBytes(32));
    assert.equal(await store.get('anything'), undefined);
    await store.set('a', '1', 'a');
    await store.set('b', '2', 'b');
    await store.delete('a');
    assert.equal(await store.get('a'), undefined);
    assert.equal(await store.get('b'), '2');
  });

  it('serialises concurrent writes in one process', async () => {
    const store = new FileStore(join(await scratch(), 'secrets.enc'), randomBytes(32));
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.set(`k${i}`, String(i), 'k')));
    for (let i = 0; i < 20; i++) assert.equal(await store.get(`k${i}`), String(i));
  });

  it('refuses the wrong key and a key of the wrong size', async () => {
    const path = join(await scratch(), 'secrets.enc');
    await new FileStore(path, randomBytes(32)).set('a', '1', 'a');
    await assert.rejects(new FileStore(path, randomBytes(32)).get('a'), SecretStoreError);
    assert.throws(() => new FileStore(path, randomBytes(16)), SecretStoreError);
  });
});

describe('secretStoreFor', () => {
  const config = { keychainService: 'shipcast-test', dataDir: '/tmp/shipcast-data' };

  it('is the keychain by default', () => {
    assert.ok(secretStoreFor(config, {}) instanceof KeychainStore);
  });

  it('is the file in <data dir>/secrets.enc with SHIPCAST_SECRET_STORE=file', () => {
    const store = secretStoreFor(config, { SHIPCAST_SECRET_STORE: 'file', SHIPCAST_SECRETS_KEY: randomBytes(32).toString('base64') });
    assert.ok(store instanceof FileStore);
    assert.equal(store.kind, 'an encrypted file');
  });

  it('says what is missing or wrong', () => {
    assert.throws(() => secretStoreFor(config, { SHIPCAST_SECRET_STORE: 'file' }), /SHIPCAST_SECRETS_KEY/);
    assert.throws(() => secretStoreFor(config, { SHIPCAST_SECRET_STORE: 'vault' }), /"keychain", "file" or "table"/);
  });
});
