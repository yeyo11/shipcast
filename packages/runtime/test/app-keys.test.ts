import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { LocalLock, SecretRows } from '@shipcast/engine';
import { memoryRegistry } from '@shipcast/engine/testing';
import { appKey, MemoryStore, provisionAppKeys, TableStore, type SecretStore } from '../src/index.ts';

test('two replicas on the table making the session key at once end with one key', async () => {
  const registry = await memoryRegistry();
  const master = randomBytes(32);
  const replicas = [new TableStore(new SecretRows(registry.database), master), new TableStore(new SecretRows(registry.database), master)];
  for (const r of replicas) provisionAppKeys(r, { env: {} });
  const values = await Promise.all(replicas.flatMap((r) => [appKey(r, 'app:session-key', 'session'), appKey(r, 'app:session-key', 'session')]));
  assert.equal(new Set(values).size, 1);
  assert.equal(Buffer.from(values[0]!, 'base64url').length, 32);
});

test('a store shared by processes makes the key under the lock, once, and each process reads it once', async () => {
  const shared = new MemoryStore();
  let reads = 0;
  const counting: SecretStore = {
    kind: 'memory',
    get: async (key) => {
      reads++;
      await new Promise((r) => setTimeout(r, 5));
      return shared.get(key);
    },
    set: (key, value, label) => shared.set(key, value, label),
    delete: (key) => shared.delete(key),
  };
  const lock = new LocalLock();
  provisionAppKeys(counting, { env: {}, lock });
  const values = await Promise.all(Array.from({ length: 5 }, () => appKey(counting, 'app:api-token-pepper', 'pepper')));
  assert.equal(new Set(values).size, 1);
  const before = reads;
  await appKey(counting, 'app:api-token-pepper', 'pepper');
  assert.equal(reads, before, 'cached in the process');
});

test('a key provisioned in the environment wins and is never written to the store', async () => {
  const store = new MemoryStore();
  provisionAppKeys(store, { env: { SHIPCAST_SESSION_KEY: 'from-the-bootstrap' } });
  assert.equal(await appKey(store, 'app:session-key', 'session'), 'from-the-bootstrap');
  assert.deepEqual(await store.keys(), []);
});

test('a store nobody provisioned reads every time, as before', async () => {
  const store = new MemoryStore();
  const first = await appKey(store, 'app:session-key', 'session');
  await store.set('app:session-key', 'changed');
  assert.equal(await appKey(store, 'app:session-key', 'session'), 'changed');
  assert.notEqual(first, 'changed');
});
