import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { SecretRows } from '@shipcast/engine';
import { memoryRegistry } from '@shipcast/engine/testing';
import { copySecrets, MemoryStore, SecretStoreError, TableStore } from '../src/index.ts';

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
