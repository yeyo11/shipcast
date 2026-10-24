import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GitHubRest, Registry } from '@shipcast/engine';
import { Brand } from '@shipcast/schema';
import { blueskyHandle, buildServices, INSTAGRAM_REFRESHED_KEY, INSTAGRAM_TOKEN_KEY, mastodonInstance, refreshInstagramToken } from '../src/services.ts';

const brand = Brand.parse({
  id: 'personal',
  displayName: 'Me',
  site: 'https://josegarrido.dev',
  github: 'yeyo11',
  handles: { bluesky: 'https://bsky.app/profile/yeyo11.bsky.social', mastodon: 'https://mastodon.social/@yeyo11' },
});
const github = new GitHubRest({ token: 'g' });

test('the public parts of each account come from the brand profiles', () => {
  assert.equal(blueskyHandle('https://bsky.app/profile/yeyo11.bsky.social'), 'yeyo11.bsky.social');
  assert.equal(mastodonInstance('https://mastodon.social/@yeyo11'), 'https://mastodon.social');
  assert.equal(blueskyHandle(undefined), undefined);
});

test('only the networks with credentials are configured', () => {
  const registry = new Registry(':memory:');
  const services = buildServices({ DEVTO_API_KEY: 'd', BLUESKY_APP_PASSWORD: 'b', INSTAGRAM_USER_ID: '1' }, brand, registry, github);
  assert.deepEqual(services.configured, ['devto', 'bluesky', 'github']);
  assert.deepEqual(Object.keys(services.publishers), ['devto', 'bluesky']);
  assert.equal(services.sources.blog, undefined);
  assert.equal(services.instagram, undefined, 'no token, no Instagram');
});

test('a refreshed Instagram token in the registry wins over the one in .env', async () => {
  const registry = new Registry(':memory:');
  registry.setCursor(INSTAGRAM_TOKEN_KEY, 'fresh');
  const services = buildServices({ INSTAGRAM_USER_ID: '1', INSTAGRAM_ACCESS_TOKEN: 'old' }, brand, registry, github);
  assert.ok(services.configured.includes('instagram'));
});

test('the Instagram token is refreshed every 30 days, never on the first run', async () => {
  const registry = new Registry(':memory:');
  let refreshes = 0;
  const services = buildServices({}, brand, registry, github);
  services.instagram = { refreshToken: async () => (refreshes++, { accessToken: 'new', expiresIn: 60 * 86400 }) } as unknown as typeof services.instagram;

  assert.equal(await refreshInstagramToken(services, registry, new Date('2026-10-01T00:00:00Z')), undefined);
  assert.equal(registry.cursor(INSTAGRAM_REFRESHED_KEY), '2026-10-01T00:00:00.000Z');
  assert.equal(await refreshInstagramToken(services, registry, new Date('2026-10-20T00:00:00Z')), undefined);
  assert.equal(refreshes, 0);

  assert.match((await refreshInstagramToken(services, registry, new Date('2026-11-01T00:00:00Z'))) ?? '', /refreshed; valid for 60/);
  assert.equal(refreshes, 1);
  assert.equal(registry.cursor(INSTAGRAM_TOKEN_KEY), 'new');
});
