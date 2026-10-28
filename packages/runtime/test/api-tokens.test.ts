import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryRegistry } from '@shipcast/engine/testing';
import { API_TOKEN_PEPPER_KEY, createApiToken, hasScope, InvalidScopes, MemoryStore, parseScopes, verifyApiToken } from '../src/index.ts';

test('a token is shown once, stored only as a keyed hash, and verifies', async () => {
  const deps = { registry: await memoryRegistry(), secrets: new MemoryStore() };
  const { token, record } = await createApiToken(deps, '  MCP server ', ['read', 'write']);
  assert.match(token, new RegExp(`^shipcast_${record.id}_[A-Za-z0-9_-]{43}$`));
  assert.equal(record.name, 'MCP server');
  assert.deepEqual(record.scopes, ['read', 'write']);
  assert.ok(await deps.secrets.get(API_TOKEN_PEPPER_KEY), 'the pepper is made on first use, in the keychain');

  const stored = await deps.registry.apiTokens.apiToken(record.id);
  assert.ok(stored);
  assert.match(stored.hash, /^[0-9a-f]{64}$/);
  assert.ok(!token.includes(stored.hash), 'the hash is not the secret');
  assert.ok(!('hash' in (await deps.registry.apiTokens.apiTokens())[0]!), 'the list never carries hashes');

  const check = await verifyApiToken(deps, token, new Date('2026-10-25T10:00:00Z'));
  assert.equal(check.ok, true);
  assert.equal(check.ok && check.token.lastUsedAt, '2026-10-25T10:00:00.000Z');
  assert.equal((await deps.registry.apiTokens.apiToken(record.id))?.lastUsedAt, '2026-10-25T10:00:00.000Z');
  // Used again within the minute: no write
  await verifyApiToken(deps, token, new Date('2026-10-25T10:00:30Z'));
  assert.equal((await deps.registry.apiTokens.apiToken(record.id))?.lastUsedAt, '2026-10-25T10:00:00.000Z');
});

test('a changed, unknown, foreign or revoked token is refused', async () => {
  const deps = { registry: await memoryRegistry(), secrets: new MemoryStore() };
  const { token, record } = await createApiToken(deps, 'cli', ['read']);
  const last = token.at(-1) === 'A' ? 'B' : 'A';
  assert.deepEqual(await verifyApiToken(deps, `${token.slice(0, -1)}${last}`), { ok: false, reason: 'unknown' });
  assert.deepEqual(await verifyApiToken(deps, token.replace(`shipcast_${record.id}_`, 'shipcast_999_')), { ok: false, reason: 'unknown' });
  assert.deepEqual(await verifyApiToken(deps, 'Bearer nonsense'), { ok: false, reason: 'malformed' });
  assert.deepEqual(await verifyApiToken(deps, ''), { ok: false, reason: 'malformed' });
  assert.deepEqual(await verifyApiToken({ ...deps, secrets: new MemoryStore() }, token), { ok: false, reason: 'unknown' }, 'another pepper, another install');

  const revoked = await deps.registry.apiTokens.revokeApiToken(record.id, new Date('2026-10-25T11:00:00Z'));
  assert.equal(revoked?.revokedAt, '2026-10-25T11:00:00.000Z');
  assert.deepEqual(await verifyApiToken(deps, token), { ok: false, reason: 'revoked' });
  // Revoking again keeps the first time
  assert.equal((await deps.registry.apiTokens.revokeApiToken(record.id, new Date('2026-10-26T00:00:00Z')))?.revokedAt, '2026-10-25T11:00:00.000Z');
  assert.equal(await deps.registry.apiTokens.revokeApiToken(404), undefined);
});

test('scopes are checked and do not include each other', () => {
  assert.deepEqual(parseScopes('write, read'), ['read', 'write']);
  assert.deepEqual(parseScopes(['read', 'read']), ['read']);
  assert.throws(() => parseScopes([]), InvalidScopes);
  assert.throws(() => parseScopes('admin'), InvalidScopes);
  assert.throws(() => parseScopes(3), InvalidScopes);
  assert.equal(hasScope({ scopes: ['write'] }, 'read'), false);
  assert.equal(hasScope({ scopes: ['read', 'write'] }, 'write'), true);
});
