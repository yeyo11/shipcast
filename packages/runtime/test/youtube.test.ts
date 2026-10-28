import assert from 'node:assert/strict';
import { test } from 'node:test';
import { YOUTUBE_DAILY_UNITS, YOUTUBE_UNITS } from '@shipcast/connectors';
import { GitHubRest, type YouTubePublisher } from '@shipcast/engine';
import { memoryRegistry } from '@shipcast/engine/testing';
import { Brand } from '@shipcast/schema';
import {
  accountSecretKey,
  buildServices,
  importYouTubeAccount,
  MemoryStore,
  networkSpec,
  NETWORKS,
  settingDefinition,
  uploadUnits,
  YOUTUBE_BUCKET,
  YOUTUBE_PROVIDER,
  YouTubeImportRefused,
  YouTubeQuota,
} from '../src/index.ts';
import { MemoryTokenBucket } from '../src/redis/index.ts';

const brand = Brand.parse({ id: 'personal', displayName: 'Me', site: 'https://josegarrido.dev', github: 'yeyo11' });

/** Google faked: the token endpoint, the channel, and the upload session; every request recorded */
function google(log: string[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    log.push(`${init?.method ?? 'GET'} ${url.split('?')[0]}`);
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      const body = new URLSearchParams(String(init?.body));
      return body.get('refresh_token') === 'revoked' ? Response.json({ error: 'invalid_grant' }, { status: 400 }) : Response.json({ access_token: 'access' });
    }
    if (url.includes('/channels?part=snippet')) return Response.json({ items: [{ snippet: { title: 'José', customUrl: '@josegarridodev' } }] });
    if (url.includes('/upload/youtube/v3/videos')) return new Response(null, { status: 200, headers: { location: 'https://upload.example/session' } });
    if (url === 'https://upload.example/session') return Response.json({ id: 'v1', status: { privacyStatus: 'private' } });
    return Response.json({});
  }) as typeof fetch;
}

const FILE = JSON.stringify({ client_id: 'client-1', client_secret: 'very-secret', refresh_token: 'refresh-1' });

test('YouTube is a network of the catalog that signs in with the client set in Settings', () => {
  const card = NETWORKS.find((n) => n.id === 'youtube');
  assert.deepEqual([card?.name, card?.channel, card?.auth, card?.metrics], ['YouTube', 'youtube', 'oauth', true]);
  const id = settingDefinition('youtubeClientId');
  const secret = settingDefinition('youtubeClientSecret');
  assert.deepEqual([id.env, id.store.key, secret.env, secret.store.kind, secret.store.key], ['YOUTUBE_CLIENT_ID', 'youtube-client-id', 'YOUTUBE_CLIENT_SECRET', 'secret', 'app:youtube-client-secret']);
  const url = new URL(networkSpec('youtube')!.oauth!.authorizeUrl({ clientId: 'c', clientSecret: 's' }, 'https://app.example/auth/youtube/callback', 'state-1'));
  assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(url.searchParams.get('access_type'), 'offline', 'a refresh token, so the account stays connected');
  assert.match(url.searchParams.get('scope') ?? '', /youtube\.upload .*youtube\.readonly .*youtube\.force-ssl/);
  assert.equal(url.searchParams.get('redirect_uri'), 'https://app.example/auth/youtube/callback');
});

test("the code exchange's answer is kept as the import keeps a file: the client with the account", async () => {
  const http = (async () => Response.json({ access_token: 'a', refresh_token: 'r-from-code' })) as unknown as typeof fetch;
  const token = await networkSpec('youtube')!.oauth!.exchange({ clientId: 'c', clientSecret: 's' }, 'https://app.example/auth/youtube/callback', 'code', http);
  assert.deepEqual(token.credentials, { settings: { clientId: 'c' }, secrets: { clientSecret: 's', refreshToken: 'r-from-code' } });
});

test('a token file is imported through the connection path: checked, its secrets in the store, nothing quoted', async () => {
  const registry = await memoryRegistry();
  const secrets = new MemoryStore();
  const deps = { registry, secrets, brands: new Map([['personal', brand]]), fetch: google() };
  const result = await importYouTubeAccount(deps, { text: FILE, brand: 'personal' });
  assert.ok(result.ok);
  const account = (result as { account: { id: number; label: string; settings: Record<string, string> } }).account;
  assert.equal(account.label, '@josegarridodev');
  assert.deepEqual(account.settings, { clientId: 'client-1' }, 'only the public client id in the registry');
  assert.deepEqual(JSON.parse((await secrets.get(accountSecretKey(account.id)))!), { clientSecret: 'very-secret', refreshToken: 'refresh-1' });

  const refused = await importYouTubeAccount(deps, { text: JSON.stringify({ client_id: 'c', client_secret: 's', refresh_token: 'revoked' }), brand: 'personal' });
  assert.equal(refused.ok, false, 'a token Google refuses is not kept');
  for (const bad of ['{"client_id": "c", "refresh_token": "very-secret-token"', JSON.stringify({ client_id: 'c', refresh_token: 'very-secret-token' })]) {
    await assert.rejects(importYouTubeAccount(deps, { text: bad, brand: 'personal' }), (error: unknown) => error instanceof YouTubeImportRefused && !error.message.includes('very-secret'));
  }
  assert.equal((await registry.accounts({ network: 'youtube' })).length, 1);
});

test("the day's quota refuses an upload it cannot pay for in full, and counts what every call spent", async () => {
  let now = 0;
  const bucket = new MemoryTokenBucket({ [YOUTUBE_PROVIDER]: YOUTUBE_BUCKET }, { now: () => now });
  const quota = new YouTubeQuota(bucket);
  const upload = { captions: [{ lang: 'en', name: 'English', srt: '' }], thumbnail: { bytes: new Uint8Array(), mimeType: 'image/png' } };
  assert.equal(uploadUnits(upload), YOUTUBE_UNITS.insert + YOUTUBE_UNITS.captionsInsert + YOUTUBE_UNITS.thumbnailsSet);
  assert.equal(await quota.left(), YOUTUBE_DAILY_UNITS);
  for (let i = 0; i < 3; i++) await quota.spend(uploadUnits(upload));
  await quota.ensure(uploadUnits(upload), 'an upload');
  await quota.spend(uploadUnits(upload));
  await assert.rejects(quota.ensure(uploadUnits(upload), 'an upload'), /today's quota cannot pay for an upload: it costs 2050 units and \d+ are left/);
  // Half a day later the bucket has refilled enough for another
  now += 12 * 3600 * 1000;
  await quota.ensure(uploadUnits(upload), 'an upload');
});

test('built from a connected account, the publisher spends the shared quota and refuses past it', async () => {
  const registry = await memoryRegistry();
  const secrets = new MemoryStore();
  const account = await registry.addAccount({ network: 'youtube', brand: 'personal', label: '@me', settings: { clientId: 'client-1' } });
  await secrets.set(accountSecretKey(account.id), JSON.stringify({ clientSecret: 's', refreshToken: 'r' }), 'x');
  const buckets = new MemoryTokenBucket({ [YOUTUBE_PROVIDER]: YOUTUBE_BUCKET });
  const log: string[] = [];
  const services = await buildServices({ env: {}, brand, registry, github: new GitHubRest({ token: 'g' }), secrets, fetch: google(log), buckets });
  assert.ok(services.configured.includes('youtube'));
  assert.equal(services.accounts.youtube, account.id);
  assert.ok(services.strategies.youtube, 'published through its strategy');
  assert.ok(!('youtube' in services.publishers), 'not one of the built-in publishers');

  // Spend the day but for less than an upload, as other calls of other replicas would
  await new YouTubeQuota(buckets).spend(YOUTUBE_DAILY_UNITS - 100);
  const video = { title: 't', description: 'd', tags: [], lang: 'en', bytes: new Uint8Array([1]), short: true };
  const publisher = (await import('../src/channels/youtube.ts')).youtubeAdapter.publisher;
  const built = (await import('../src/index.ts')).buildConnector('youtube', { settings: { clientId: 'c' }, secrets: { clientSecret: 's', refreshToken: 'r' } }, brand, google(log), { buckets });
  await assert.rejects((publisher(built.connector as never) as YouTubePublisher).publish(video), /quota cannot pay/);
  assert.equal(log.filter((l) => l.includes('/upload/')).length, 0, 'nothing was sent');
});
