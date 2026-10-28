import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { MemoryFakeNetworkLedger, PostgresFakeNetworkLedger, publishLaunch, youtubeStrategy, type GitHubRest, type MetricSources, type PipelineDeps, type Repositories } from '@shipcast/engine';
import { aLaunch, FakeGitHub, LAUNCHES_REPO, memoryRegistry } from '@shipcast/engine/testing';
import { Brand } from '@shipcast/schema';
import {
  assertPreviewSafe,
  CHANNEL_ADAPTERS,
  checkScale,
  ConfigError,
  expectedKinds,
  FAKE_STRATEGY_PUBLISHERS,
  fakeNetworks,
  fakePublishers,
  planScale,
  PREVIEW_OAUTH_CODE,
  PreviewFixtures,
  previewDatabase,
  previewWorld,
  publishConnectors,
  runRound,
  scaleFiles,
  SCALE_CHANNELS,
  withGitHubFixtures,
  withSiteFixtures,
  type AnyChannelAdapter,
  type Services,
} from '../src/index.ts';

const brand = Brand.parse({
  id: 'personal',
  displayName: 'Me',
  site: 'https://josegarrido.dev',
  github: 'yeyo11',
  newsletter: { sender: { name: 'Me', email: 'me@josegarrido.dev' }, lists: { en: 3 } },
});

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tempFixtures = () => {
  const dir = mkdtempSync(join(tmpdir(), 'shipcast-fixtures-'));
  dirs.push(dir);
  return new PreviewFixtures(dir);
};

/** The services a brand would have, with a real-looking publisher that must never be called */
function realServices(): Services {
  const forbidden = { publish: async () => assert.fail('a preview reached a real publisher') };
  return {
    publishers: { telegram: forbidden, mastodon: { publish: forbidden.publish }, devto: forbidden },
    strategies: { youtube: { run: () => async () => assert.fail('a preview reached a real strategy') } },
    sources: {} as MetricSources,
    instagram: { connector: { refreshToken: async () => assert.fail('a preview refreshed a real token') }, origin: { kind: 'env' } },
    notifier: { notify: async () => assert.fail('a preview notified the owner for real') },
    configured: [],
    origins: {},
    accounts: {},
  };
}

/** The adapters, with YouTube's renderer faked so the test needs no ffmpeg */
const testAdapters: readonly AnyChannelAdapter[] = CHANNEL_ADAPTERS.map((a) =>
  a.definition.id === 'youtube'
    ? ({
        ...a,
        strategy: youtubeStrategy({
          render: async (request) => {
            await writeFile(request.output, 'mp4');
            return { srt: '1\n00:00:00,000 --> 00:00:01,000\nhi\n', chapters: [] };
          },
          duration: async () => 4,
        }),
      } as AnyChannelAdapter)
    : a,
);

test('the switch: plain HTTP anywhere, or behind a proxy only on a …_preview database', () => {
  assert.equal(fakeNetworks({ SHIPCAST_PREVIEW_FAKE_NETWORKS: '1', SHIPCAST_APP_TLS: 'off' }), true);
  assert.equal(fakeNetworks({ SHIPCAST_PREVIEW_FAKE_NETWORKS: '1' }), false, 'a copy serving TLS is production');
  assert.equal(fakeNetworks({ SHIPCAST_PREVIEW_FAKE_NETWORKS: '1', SHIPCAST_APP_TLS: 'proxy', SHIPCAST_DATABASE_URL: 'postgres://s:p@pgbouncer:5432/shipcast' }), false, "production's database never takes the switch");
  assert.equal(fakeNetworks({ SHIPCAST_PREVIEW_FAKE_NETWORKS: '1', SHIPCAST_APP_TLS: 'proxy', SHIPCAST_DATABASE_URL: 'postgres://s:p@pgbouncer:5432/shipcast_preview' }), true);
  assert.equal(fakeNetworks({ SHIPCAST_APP_TLS: 'proxy', SHIPCAST_DATABASE_URL: 'postgres://s:p@pgbouncer:5432/shipcast_preview' }), false);
  assert.equal(previewDatabase('postgres://s:p@h:5432/shipcast_preview'), true);
  assert.equal(previewDatabase('postgres://s:p@h:5432/shipcast_preview_old'), false);
  assert.equal(previewDatabase('not a url'), false);
});

test('a preview database without the switch does not start; production without it does', () => {
  assert.throws(() => assertPreviewSafe({ SHIPCAST_APP_TLS: 'proxy', SHIPCAST_DATABASE_URL: 'postgres://s:p@pgbouncer:5432/shipcast_preview' }), ConfigError);
  assert.throws(
    () => assertPreviewSafe({ SHIPCAST_APP_TLS: 'proxy', SHIPCAST_DATABASE_URL: 'postgres://s:p@pgbouncer:5432/shipcast_preview', SHIPCAST_DATABASE_MIGRATE_URL: 'postgres://s:p@postgres:5432/shipcast', SHIPCAST_PREVIEW_FAKE_NETWORKS: '1' }),
    ConfigError,
    "a preview never migrates production's database",
  );
  assertPreviewSafe({ SHIPCAST_APP_TLS: 'proxy', SHIPCAST_DATABASE_URL: 'postgres://s:p@pgbouncer:5432/shipcast' });
  assertPreviewSafe({ SHIPCAST_APP_TLS: 'proxy', SHIPCAST_PREVIEW_FAKE_NETWORKS: '1', SHIPCAST_DATABASE_URL: 'postgres://s:p@pgbouncer:5432/shipcast_preview', SHIPCAST_DATABASE_MIGRATE_URL: 'postgres://s:p@postgres:5432/shipcast_preview' });
});

test('every channel adapter has a fake publisher, every editor a fake editor, every notifier the fake one', async () => {
  const ledger = new MemoryFakeNetworkLedger();
  const world = previewWorld({ ledger });
  const services = world.services(realServices());
  const editors = await world.editors('mastodon', null);
  for (const adapter of CHANNEL_ADAPTERS) {
    const id = adapter.definition.id;
    if (adapter.strategy) {
      assert.ok(FAKE_STRATEGY_PUBLISHERS[id], `${id} publishes through a strategy and has no fake publisher for it`);
      assert.ok(services.strategies[id], `${id}'s strategy is not bound to its fake`);
    } else {
      assert.ok(id in services.publishers, `${id} has no fake publisher`);
    }
    if (adapter.editor) assert.ok(id in editors, `${id} edits on its network and has no fake editor`);
  }
  assert.ok(CHANNEL_ADAPTERS.some((a) => a.definition.id === 'youtube' && a.strategy), 'YouTube is among them, through its strategy');
  assert.ok(CHANNEL_ADAPTERS.some((a) => a.notifier), 'some adapter brings a notifier');
  await services.notifier!.notify('a notice');
  assert.equal(services.instagram, undefined, 'no token refresh reaches Meta');
  assert.equal(services.sources.search, undefined, 'no Search Console ping');
  await editors.mastodon!.delete('m-1');
  assert.deepEqual(
    ledger.entries.map((e) => `${e.channel} ${e.action} ${e.kind}`),
    ['telegram notify notice', 'mastodon delete m-1'],
  );
});

test('a launch on every channel goes out once per piece to the fake networks, YouTube included', async () => {
  const registry = await memoryRegistry();
  const ledger = new MemoryFakeNetworkLedger();
  const fixtures = tempFixtures();
  const plan = planScale({ run: 'rtest', pieces: SCALE_CHANNELS.length, start: new Date('2026-10-30T10:00:00Z'), durationMs: 3600_000 });
  assert.equal(plan.launches.length, 1);
  const planned = plan.launches[0]!;
  const launch = await aLaunch(registry, { repo: planned.repo, ref: planned.ref, detail: 'direct:scale' });
  planned.launchId = launch.id;
  const files = scaleFiles(planned, launch, { launchesRepo: LAUNCHES_REPO, site: brand.site, brand: brand.id });
  for (const f of files.github) fixtures.writeGitHub(f.repo, f.path, f.content);
  for (const f of files.site) fixtures.writeSite(f.url, f.content);
  const github = new FakeGitHub({ files: Object.fromEntries(files.github.map((f) => [FakeGitHub.key(f.repo, f.path, f.repo === LAUNCHES_REPO ? 'HEAD' : planned.ref), f.content])) });
  const noSite = (async (input: string | URL | Request) => assert.fail(`a preview read the real site: ${String(input)}`)) as typeof fetch;

  const world = previewWorld({ ledger, fixtures, fetch: noSite, adapters: testAdapters });
  const services = world.services(realServices());
  const deps = { github, registry, launchesRepo: LAUNCHES_REPO, ...publishConnectors(services) };
  const first = await publishLaunch(launch, brand, deps);
  assert.equal(first.state, 'published', JSON.stringify(first.state === 'published' || first.state === 'partial' ? first.problems : first));

  const sent = ledger.entries.filter((e) => e.action === 'publish').map((e) => `${e.channel} ${e.kind}`).sort();
  const expected = SCALE_CHANNELS.flatMap((c) => expectedKinds(c).map((k) => `${c} ${k}`)).sort();
  assert.deepEqual(sent, expected);
  assert.ok(ledger.entries.every((e) => e.marker === planned.marker), 'every piece carries its launch’s marker');

  // Published again (a second worker, a retry): nothing more reaches the networks
  await publishLaunch((await registry.launches.get(launch.id))!, brand, deps);
  assert.equal(ledger.entries.filter((e) => e.action === 'publish').length, expected.length);

  const rows = await registry.posts.posts(launch.id);
  const summary = checkScale({
    plan,
    registry: rows.map((r) => ({ launchId: r.launchId, channel: r.channel, kind: r.kind, status: r.status, externalId: r.externalId, scheduledAt: r.scheduledAt, publishedAt: r.publishedAt })),
    ledger: ledger.entries,
    unknown: [],
    exercise: [],
    secrets: [],
    now: new Date('2026-10-31T00:00:00Z'),
  });
  assert.equal(summary.verdict, 'pass', summary.problems.join('; '));
  assert.equal(summary.counts.ok, expected.length);
});

test('Mastodon keeps an idempotency key and Reddit finds a lost submission, as their networks do', async () => {
  const ledger = new MemoryFakeNetworkLedger();
  const publishers = fakePublishers({ ledger });
  const first = await publishers.mastodon.publish({ text: 'hi', lang: 'en', idempotencyKey: 'shipcast-7-mastodon' });
  const again = await publishers.mastodon.publish({ text: 'hi', lang: 'en', idempotencyKey: 'shipcast-7-mastodon' });
  assert.equal(again.externalId, first.externalId);
  assert.equal(ledger.entries.length, 1);
  assert.equal(await publishers.reddit.find({ subreddit: 'rust', title: 'T' }, new Date(0)), undefined);
  const posted = await publishers.reddit.publish({ subreddit: 'rust', title: 'T', text: 'b' });
  assert.equal((await publishers.reddit.find({ subreddit: 'rust', title: 'T' }, new Date(0)))?.externalId, posted.externalId);
});

test("the ledger in Postgres is made on first use, shared and searchable", async () => {
  const registry = await memoryRegistry();
  const a = new PostgresFakeNetworkLedger(registry.database, 'worker@a');
  const b = new PostgresFakeNetworkLedger(registry.database, 'worker@b');
  await Promise.all([a.ensure(), b.ensure()]);
  await a.record({ channel: 'bluesky', action: 'publish', kind: 'post', externalId: 'x1', marker: '[scale r1 0]', detail: '{"text":"one"}' });
  await b.record({ channel: 'reddit', action: 'publish', kind: 'post:rust', externalId: 'x2', marker: null, detail: '{"title":"T"}' });
  const all = await a.entries();
  assert.deepEqual(all.map((e) => `${e.process} ${e.channel} ${e.externalId} ${e.marker}`), ['worker@a bluesky x1 [scale r1 0]', 'worker@b reddit x2 null']);
  assert.equal((await b.find('reddit', 'post:rust', '"title":"T"'))?.externalId, 'x2');
  assert.equal(await b.find('reddit', 'post:rust', '"title":"U"'), undefined);
});

test('fixtures answer GitHub and the site, own their folders, and never leave their root', async () => {
  const fixtures = tempFixtures();
  fixtures.writeGitHub('o/r', '.github/launch.yml', 'enabled: true\n');
  fixtures.writeSite('https://site.dev/media/x/og.jpg', new Uint8Array([1, 2]));
  const passed: string[] = [];
  const next = (async (input: string | URL | Request) => {
    passed.push(String(input));
    return new Response('real');
  }) as typeof fetch;
  const gh = withGitHubFixtures(fixtures, next);
  assert.equal(await (await gh('https://api.github.com/repos/o/r/contents/.github/launch.yml?ref=v1')).text(), 'enabled: true\n');
  await gh('https://api.github.com/repos/o/r/contents/README.md');
  const site = withSiteFixtures(fixtures, next);
  assert.equal((await site('https://site.dev/media/x/og.jpg')).status, 200);
  assert.equal((await site('https://site.dev/media/x/story.png', { method: 'HEAD' })).status, 404, 'a missing file in a fixtures folder is theirs to refuse');
  await site('https://site.dev/en/post/');
  assert.deepEqual(passed, ['https://api.github.com/repos/o/r/contents/README.md', 'https://site.dev/en/post/']);
  assert.throws(() => fixtures.writeGitHub('o/r', '../../escape', 'x'));
  assert.equal(fixtures.github('o/r', '../../../etc/passwd'), undefined);
});

test("a preview's sign-in never leaves the app: its consent comes back to the callback, the token is made up", async () => {
  const ledger = new MemoryFakeNetworkLedger();
  const { oauth } = previewWorld({ ledger });
  const url = new URL(oauth.authorizeUrl('https://shipcast-preview.example', 'youtube', 'st4te'));
  assert.equal(url.pathname, '/auth/youtube/callback');
  assert.equal(url.searchParams.get('state'), 'st4te');
  assert.equal(url.searchParams.get('code'), PREVIEW_OAUTH_CODE);
  const token = await oauth.exchange('youtube', PREVIEW_OAUTH_CODE, 'scale-1');
  assert.equal(token.label, 'scale-1');
  assert.deepEqual(await oauth.check('youtube', token.credentials), { ok: true, account: 'scale-1' });
  await assert.rejects(oauth.exchange('youtube', 'a-real-code', undefined));
  assert.deepEqual(ledger.entries.map((e) => `${e.channel} ${e.action}`), ['youtube connect']);
});

test("the round publishes with the process's own services when it has them (a preview's), never with the brand's", async () => {
  const registry = await memoryRegistry();
  const ledger = new MemoryFakeNetworkLedger();
  const launch = await aLaunch(registry, { detail: 'direct:x' });
  const pack = { schemaVersion: 1, kind: 'launch', project: { name: 'claudio', repo: 'https://github.com/yeyo11/claudio' }, analysis: { summary: 's', implemented: ['x'], planned: [], documentedOnly: [], limitations: [] }, telegram: { text: 'hi' } };
  const github = new FakeGitHub({
    files: {
      [FakeGitHub.key(LAUNCHES_REPO, 'launches/claudio/v1.0.0/pack.json')]: JSON.stringify(pack),
      [FakeGitHub.key('yeyo11/claudio', '.github/launch.yml', 'v1.0.0')]: 'enabled: true\nbrand: personal\npublishing:\n  blog: off\n  telegram: auto\n',
    },
  });
  const world = previewWorld({ ledger });
  const lines: string[] = [];
  await runRound(
    {
      // Telegram's credentials in .env: the brand's own services would post for real
      env: { TELEGRAM_BOT_TOKEN: 'real', TELEGRAM_CHAT_ID: '@real' },
      registry: registry as Repositories,
      github: github as unknown as GitHubRest,
      secrets: { kind: 'memory' } as never,
      brand,
      pipeline: { launchesRepo: LAUNCHES_REPO } as PipelineDeps,
      services: async () => world.services(realServices()),
      log: (line) => lines.push(line),
    },
    { detect: false },
  );
  assert.deepEqual(ledger.entries.filter((e) => e.action === 'publish').map((e) => e.channel), ['telegram'], lines.join('\n'));
});
