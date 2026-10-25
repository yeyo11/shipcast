import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GitHubRest, Registry } from '@shipcast/engine';
import { Brand } from '@shipcast/schema';
import {
  accountSecretKey,
  blueskyHandle,
  buildServices,
  INSTAGRAM_REFRESHED_KEY,
  INSTAGRAM_TOKEN_KEY,
  mastodonInstance,
  MemoryStore,
  refreshInstagramToken,
  type ServiceDeps,
  type Services,
} from '../src/index.ts';

const brand = Brand.parse({
  id: 'personal',
  displayName: 'Me',
  site: 'https://josegarrido.dev',
  github: 'yeyo11',
  handles: { bluesky: 'https://bsky.app/profile/yeyo11.bsky.social', mastodon: 'https://mastodon.social/@yeyo11' },
});
const company = Brand.parse({ id: 'company', displayName: 'Co', site: 'https://co.example', github: 'co' });
const github = new GitHubRest({ token: 'g' });

function deps(env: NodeJS.ProcessEnv, over: Partial<ServiceDeps> = {}): ServiceDeps {
  return { env, brand, registry: new Registry(':memory:'), github, secrets: new MemoryStore(), readFile: () => '{}', ...over };
}

test('the public parts of each account come from the brand profiles', () => {
  assert.equal(blueskyHandle('https://bsky.app/profile/yeyo11.bsky.social'), 'yeyo11.bsky.social');
  assert.equal(mastodonInstance('https://mastodon.social/@yeyo11'), 'https://mastodon.social');
  assert.equal(blueskyHandle(undefined), undefined);
});

test('only the networks with credentials are configured', async () => {
  const services = await buildServices(deps({ DEVTO_API_KEY: 'd', BLUESKY_APP_PASSWORD: 'b', INSTAGRAM_USER_ID: '1' }));
  assert.deepEqual(services.configured, ['devto', 'bluesky', 'github']);
  assert.deepEqual(Object.keys(services.publishers), ['devto', 'bluesky']);
  assert.equal(services.sources.blog, undefined);
  assert.equal(services.instagram, undefined, 'no token, no Instagram');
  assert.deepEqual(services.origins.devto, { kind: 'env' });
});

test('a connected account wins over .env, and .env never speaks for another brand', async () => {
  const registry = new Registry(':memory:');
  const secrets = new MemoryStore();
  const account = registry.addAccount({ network: 'mastodon', brand: 'personal', label: '@me', settings: { instance: 'https://fosstodon.org' } });
  await secrets.set(accountSecretKey(account.id), JSON.stringify({ accessToken: 'from-keychain' }), 'x');
  const env = { MASTODON_ACCESS_TOKEN: 'from-env', DEVTO_API_KEY: 'd' };

  const personal = await buildServices(deps(env, { registry, secrets }));
  assert.deepEqual(personal.origins.mastodon, { kind: 'account', id: account.id });
  assert.ok(personal.configured.includes('devto'));

  const other = await buildServices(deps(env, { registry, secrets, brand: company }));
  assert.deepEqual(other.configured, ['github'], 'the company brand gets nothing from the personal .env');
});

test('a refreshed Instagram token in the registry wins over the one in .env', async () => {
  const registry = new Registry(':memory:');
  registry.setCursor(INSTAGRAM_TOKEN_KEY, 'fresh');
  const services = await buildServices(deps({ INSTAGRAM_USER_ID: '1', INSTAGRAM_ACCESS_TOKEN: 'old' }, { registry }));
  assert.ok(services.configured.includes('instagram'));
});

function withFakeInstagram(services: Services, origin: NonNullable<Services['instagram']>['origin'], counter: { n: number }): Services {
  const connector = { refreshToken: async () => (counter.n++, { accessToken: 'new', expiresIn: 60 * 86400 }) } as unknown as NonNullable<Services['instagram']>['connector'];
  return { ...services, instagram: { connector, origin } };
}

test('the Instagram token from .env is refreshed every 30 days, never on the first run', async () => {
  const d = deps({});
  const counter = { n: 0 };
  const services = withFakeInstagram(await buildServices(d), { kind: 'env' }, counter);

  assert.equal(await refreshInstagramToken(services, d, new Date('2026-10-01T00:00:00Z')), undefined);
  assert.equal(d.registry.cursor(INSTAGRAM_REFRESHED_KEY), '2026-10-01T00:00:00.000Z');
  assert.equal(await refreshInstagramToken(services, d, new Date('2026-10-20T00:00:00Z')), undefined);
  assert.equal(counter.n, 0);

  assert.match((await refreshInstagramToken(services, d, new Date('2026-11-01T00:00:00Z'))) ?? '', /refreshed; valid for 60/);
  assert.equal(counter.n, 1);
  assert.equal(d.registry.cursor(INSTAGRAM_TOKEN_KEY), 'new');
});

test('a connected Instagram account keeps its refreshed token in the keychain', async () => {
  const d = deps({});
  const account = d.registry.addAccount({ network: 'instagram', brand: 'personal', label: '@me', settings: { userId: '1', refreshedAt: '2026-09-01T00:00:00.000Z' } });
  await d.secrets.set(accountSecretKey(account.id), JSON.stringify({ accessToken: 'old' }), 'x');
  const counter = { n: 0 };
  const services = withFakeInstagram(await buildServices(d), { kind: 'account', id: account.id }, counter);

  assert.match((await refreshInstagramToken(services, d, new Date('2026-10-05T00:00:00Z'))) ?? '', /refreshed/);
  assert.equal(JSON.parse((await d.secrets.get(accountSecretKey(account.id)))!).accessToken, 'new');
  assert.equal(d.registry.account(account.id)?.settings.refreshedAt, '2026-10-05T00:00:00.000Z');
  assert.equal(d.registry.cursor(INSTAGRAM_TOKEN_KEY), undefined, 'nothing in the registry');
});
