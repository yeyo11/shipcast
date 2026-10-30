import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UmamiAnalytics } from '@shipcast/connectors';
import { GitHubRest } from '@shipcast/engine';
import { memoryRegistry } from '@shipcast/engine/testing';
import { Brand } from '@shipcast/schema';
import { accountSecretKey, buildConnector, buildServices, Flags, MemoryStore, MissingField, NETWORKS, networksOn } from '../src/index.ts';

/*
 * The Umami source (SHP-4) ships behind the `umami` flag: off, Shipcast lists and reads exactly what
 * it did before; on, a connected Umami account is the hourly reads' `umami` source.
 */

const brand = Brand.parse({ id: 'personal', displayName: 'Me', site: 'https://josegarrido.dev', github: 'yeyo11' });

async function withUmamiAccount() {
  const registry = await memoryRegistry();
  const secrets = new MemoryStore();
  const account = await registry.accounts.addAccount({ network: 'umami', brand: 'personal', label: 'Blog', settings: { url: 'https://umami.example', websiteId: 'w1' } });
  await secrets.set(accountSecretKey(account.id), JSON.stringify({ apiKey: 'umami_k' }), 'x');
  return { registry, secrets };
}

test('with the flag off, the Channels page lists the networks it listed before Umami', () => {
  const before = NETWORKS.filter((n) => n.id !== 'umami');
  assert.deepEqual(networksOn(new Flags()), before);
  assert.deepEqual(networksOn(Flags.fromEnv({})), before);
  assert.deepEqual(
    networksOn(new Flags(['umami'])).map((n) => n.id),
    NETWORKS.map((n) => n.id),
  );
  assert.equal(NETWORKS.find((n) => n.id === 'umami')?.flag, 'umami');
});

test('with the flag off, a connected Umami account is not read', async () => {
  const { registry, secrets } = await withUmamiAccount();
  const services = await buildServices({ env: {}, brand, registry, github: new GitHubRest({ token: 'g' }), secrets, flags: new Flags() });
  assert.equal(services.sources.umami, undefined);
  assert.ok(!services.configured.includes('umami'));
  // The environment's flags are the default
  const fromEnv = await buildServices({ env: { SHIPCAST_FLAGS: '' }, brand, registry, github: new GitHubRest({ token: 'g' }), secrets });
  assert.equal(fromEnv.sources.umami, undefined);
});

test('with the flag on, a connected Umami account is the hourly reads’ umami source', async () => {
  const { registry, secrets } = await withUmamiAccount();
  const services = await buildServices({ env: { SHIPCAST_FLAGS: 'umami' }, brand, registry, github: new GitHubRest({ token: 'g' }), secrets });
  assert.ok(services.sources.umami instanceof UmamiAnalytics);
  assert.ok(services.configured.includes('umami'));
});

test('an Umami account needs its address, its website and an API key or a user', () => {
  const settings = { url: 'https://umami.example', websiteId: 'w1' };
  assert.throws(() => buildConnector('umami', { settings, secrets: {} }, brand), MissingField);
  assert.throws(() => buildConnector('umami', { settings: { ...settings, username: 'admin' }, secrets: {} }, brand), MissingField);
  assert.throws(() => buildConnector('umami', { settings: { url: 'https://umami.example' }, secrets: { apiKey: 'k' } }, brand), MissingField);
  assert.ok(buildConnector('umami', { settings, secrets: { apiKey: 'k' } }, brand).connector instanceof UmamiAnalytics);
  assert.ok(buildConnector('umami', { settings: { ...settings, username: 'admin' }, secrets: { password: 'p' } }, brand).connector instanceof UmamiAnalytics);
});
