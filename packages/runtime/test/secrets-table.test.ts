import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { SecretRows } from '@shipcast/engine';
import { memoryRegistry } from '@shipcast/engine/testing';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copySecrets, FileStore, Flags, MemoryStore, migrateSecrets, migrationLines, SecretStoreError, secretStoreFor, TableStore } from '../src/index.ts';

async function table(key = randomBytes(32)) {
  const registry = await memoryRegistry();
  return { registry, store: new TableStore(new SecretRows(registry.database), key), key };
}

test('a secret is sealed in its row and opens with the master key only', async () => {
  const { registry, store, key } = await table();
  await store.set('account:3', '{"token":"s3cr3t-value"}', 'Bluesky @josegarrido.dev');
  assert.equal(await store.get('account:3'), '{"token":"s3cr3t-value"}');
  const row = await new SecretRows(registry.database).get('account:3');
  assert.ok(row);
  assert.doesNotMatch(JSON.stringify(row), /s3cr3t/);
  assert.equal(row.label, 'Bluesky @josegarrido.dev');
  const other = new TableStore(new SecretRows(registry.database), randomBytes(32));
  await assert.rejects(other.get('account:3'), SecretStoreError);
  assert.ok(key.length === 32);
});

test('writes of two replicas to different keys at once both land', async () => {
  const { store } = await table();
  await Promise.all(Array.from({ length: 20 }, (_, i) => store.set(`account:${i}`, `value-${i}`)));
  assert.equal((await store.keys()).length, 20);
  for (let i = 0; i < 20; i++) assert.equal(await store.get(`account:${i}`), `value-${i}`);
});

test('compare-and-set: of two refreshes over the same version, one wins and the other learns it lost', async () => {
  const { store } = await table();
  await store.set('github:user-token', 'v1');
  const read = await store.read('github:user-token');
  const [a, b] = await Promise.all([store.compareAndSet('github:user-token', 'from-a', read!.version), store.compareAndSet('github:user-token', 'from-b', read!.version)]);
  assert.equal([a, b].filter(Boolean).length, 1);
  assert.equal(await store.get('github:user-token'), a ? 'from-a' : 'from-b');
  assert.equal(await store.compareAndSet('new', 'x', 0), true);
  assert.equal(await store.compareAndSet('new', 'y', 0), false, 'version 0 only creates');
});

test('a copy reads every value back, and never overwrites a different value already there', async () => {
  const { store } = await table();
  const from = new MemoryStore();
  await from.set('a', '1');
  await from.set('b', '2');
  await from.set('c', '3');
  await store.set('c', 'changed since');
  const result = await copySecrets(from, store);
  assert.deepEqual(result.copied.sort(), ['a', 'b']);
  assert.deepEqual(result.conflicts, ['c']);
  assert.equal(await store.get('c'), 'changed since');
  assert.equal(await from.get('a'), '1', 'the source is only read');
  const again = await copySecrets(from, store);
  assert.deepEqual(again.copied, []);
  assert.deepEqual(again.same.sort(), ['a', 'b']);
});

test('SHIPCAST_SECRET_STORE=table is the table, only with the secrets-table flag; off, the old stores as they were', async () => {
  const registry = await memoryRegistry();
  const rows = new SecretRows(registry.database);
  const config = { keychainService: 'shipcast-test', dataDir: '/tmp/shipcast-data' };
  const env = { SHIPCAST_SECRET_STORE: 'table', SHIPCAST_SECRETS_KEY: randomBytes(32).toString('base64') };
  assert.ok(secretStoreFor(config, env, { flags: new Flags(['secrets-table']), rows }) instanceof TableStore);
  assert.throws(() => secretStoreFor(config, env, { flags: new Flags(), rows }), /secrets-table flag/);
  assert.throws(() => secretStoreFor(config, env), /does not open the registry/);
  assert.throws(() => secretStoreFor(config, { SHIPCAST_SECRET_STORE: 'table' }, { flags: new Flags(['secrets-table']), rows }), /SHIPCAST_SECRETS_KEY/);
  const file = { SHIPCAST_SECRET_STORE: 'file', SHIPCAST_SECRETS_KEY: env.SHIPCAST_SECRETS_KEY };
  assert.ok(secretStoreFor(config, file, { flags: new Flags(['secrets-table']), rows }) instanceof FileStore, 'the flag alone moves nothing');
});

test('the migration copies a file store into the table, reads each back, names keys only, and leaves the file as it was', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shipcast-secrets-'));
  try {
    const key = randomBytes(32);
    const file = new FileStore(join(dir, 'secrets.enc'), key);
    await file.set('app:session-key', 'session-value-1');
    await file.set('account:4', '{"token":"t0ken-value"}');
    const before = await readFile(join(dir, 'secrets.enc'), 'utf8');
    const { store } = await table(key);
    await store.set('account:9', 'different');
    await file.set('account:9', 'the-file-one');
    const before2 = await readFile(join(dir, 'secrets.enc'), 'utf8');
    assert.notEqual(before, before2);

    const result = await migrateSecrets(file, store);
    assert.deepEqual(result.copied.sort(), ['account:4', 'app:session-key']);
    assert.deepEqual(result.conflicts, ['account:9']);
    assert.equal(await store.get('app:session-key'), 'session-value-1');
    assert.equal(await store.get('account:9'), 'different', 'a different value already there is never overwritten');
    assert.equal(await readFile(join(dir, 'secrets.enc'), 'utf8'), before2, 'the source was only read');
    const text = migrationLines(result).join('\n');
    assert.match(text, /copied and read back: 2: account:4, app:session-key/);
    assert.doesNotMatch(text, /session-value|t0ken|the-file-one|different/, 'no value is ever printed');

    const again = await migrateSecrets(file, store);
    assert.deepEqual([again.copied, again.same.sort()], [[], ['account:4', 'app:session-key']], 'running it again copies nothing');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('two replicas on one table: what each writes, the other reads', async () => {
  const registry = await memoryRegistry();
  const key = randomBytes(32);
  const one = new TableStore(new SecretRows(registry.database), key);
  const two = new TableStore(new SecretRows(registry.database), key);
  await Promise.all([one.set('account:1', 'from-one'), two.set('account:2', 'from-two')]);
  assert.equal(await one.get('account:2'), 'from-two');
  assert.equal(await two.get('account:1'), 'from-one');
});
