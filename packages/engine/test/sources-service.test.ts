import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { test } from 'node:test';
import { parseLaunchConfig, ShipcastError, type Brand } from '@shipcast/schema';
import { LaunchRefused, SourcesService, unavailableMediaStore, type LaunchService, type NewLaunchSource } from '../src/index.ts';
import { memoryRegistry, MemoryMediaStore } from '../src/testing/index.ts';

/*
 * SourcesService: the one way the app and the REST API make a launch from sources. What can be
 * refused is refused before the claim, a launch with no repo is claimed by its title, one with a
 * primary repo through the manual claim of its release, and the sources are recorded in order.
 */

const brand = { id: 'personal', displayName: 'Me', site: 'https://josegarrido.dev', github: 'yeyo11', languages: { blog: ['es', 'en'] } } as unknown as Brand;
const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const chunk = (type: string, data: number[]) => [...u32(data.length), ...ascii(type), ...data, 0, 0, 0, 0];
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunk('IHDR', [...u32(1), ...u32(1), 8, 2, 0, 0, 0]), ...chunk('eXIf', ascii('GPS')), ...chunk('IDAT', [...deflateSync(Buffer.from([0, 0, 0, 0]))]), ...chunk('IEND', [])]);

class Refused extends ShipcastError {}

async function setup(options: { media?: MemoryMediaStore } = {}) {
  const registry = await memoryRegistry();
  const media = options.media ?? new MemoryMediaStore();
  const fetched: string[] = [];
  const manual: string[] = [];
  const launchService: Pick<LaunchService, 'claimManual'> = {
    claimManual: async (repo, ref) => {
      manual.push(`${repo}@${ref ?? 'latest'}`);
      const { launch } = await registry.launches.claim({ repo, ref: ref ?? 'v2.0.0', trigger: 'manual', kind: 'launch', brand: 'personal' });
      return { launch, preflight: { ok: true, checks: [] } as never };
    },
  };
  const service = new SourcesService({
    launchService,
    launches: registry.launches,
    sources: registry.sources,
    launchesRepo: 'yeyo11/launches',
    media,
    fetchPage: async (url): Promise<NewLaunchSource> => {
      fetched.push(url);
      if (url.includes('169.254')) throw new Refused('the address 169.254.169.254 is not public');
      return { kind: 'url', role: 'context', url, text: 'page', contentType: 'text/html', httpStatus: 200, fetchedAt: '2026-10-30T00:00:00Z', meta: {}, contentHash: 'h' };
    },
  });
  return { registry, media, service, fetched, manual };
}

test('a launch with no repo is claimed under its title, with its channels and its sources in order', async () => {
  const { registry, service, media } = await setup();
  const file = await service.upload(PNG);
  assert.ok(media.objects.has(file.path), 'the bytes went to the media store');
  assert.ok(!Buffer.from(media.objects.get(file.path)!.body).includes('eXIf'), 'stored without its EXIF');
  assert.equal(file.mime, 'image/png');

  const launch = await service.create(
    {
      title: 'Why I self-host',
      lang: 'en',
      channels: ['bluesky', 'githubDiscussions'],
      sources: [{ kind: 'text', text: ' My notes. ', title: 'Notes' }, { kind: 'url', url: 'https://example.com/post' }, { kind: 'media', sha256: file.sha256, alt: 'the rack' }],
    },
    brand,
  );
  assert.equal(launch.repo, 'yeyo11/launches');
  assert.equal(launch.ref, 'article:why-i-self-host');
  assert.equal(launch.trigger, 'manual');
  const fields = (await registry.launches.modelFields(launch.id))!;
  assert.equal(fields.title, 'Why I self-host');
  const config = parseLaunchConfig(fields.channelsSource ?? '');
  assert.ok(config.ok);
  assert.equal(config.value.publishing.bluesky, 'approval');
  assert.equal(config.value.publishing.githubDiscussions, 'off', 'no repo to post Discussions in');

  const rows = await registry.sources.list(launch.id);
  assert.deepEqual(rows.map((r) => r.kind), ['text', 'url', 'media']);
  assert.equal(rows[0]!.text, 'My notes.');
  assert.equal(rows[2]!.media?.sha256, file.sha256);
  assert.notEqual(rows[2]!.media?.id, file.id, 'the launch owns its media row');
  assert.deepEqual(rows[2]!.meta, { alt: 'the rack' });
});

test('a launch with a primary repo is that release, claimed by hand with its pre-flight', async () => {
  const { registry, service, manual } = await setup();
  const launch = await service.create(
    { title: 'claudio and its site', lang: 'es', channels: [], sources: [{ kind: 'repo', repo: 'yeyo11/claudio-web' }, { kind: 'repo', repo: 'yeyo11/claudio', primary: true }] },
    brand,
  );
  assert.deepEqual(manual, ['yeyo11/claudio@latest']);
  assert.equal(launch.repo, 'yeyo11/claudio');
  const rows = await registry.sources.list(launch.id);
  assert.deepEqual(rows.map((r) => [r.kind, r.role, r.repo, r.ref]), [
    ['repo', 'context', 'yeyo11/claudio-web', null],
    ['repo_release', 'primary', 'yeyo11/claudio', 'v2.0.0'],
  ], 'the primary repo at the release claimed');
  assert.equal((await registry.launches.modelFields(launch.id))!.channelsSource, null, 'its launch.yml chooses the channels');
});

test('what can be refused is refused before anything is claimed', async () => {
  const { registry, service, fetched } = await setup();
  await assert.rejects(service.create({ title: 'x', lang: 'en', channels: [], sources: [] }, brand), (e: unknown) => e instanceof LaunchRefused && e.reason === 'invalid');
  await assert.rejects(
    service.create({ title: 'Metadata', lang: 'en', channels: [], sources: [{ kind: 'url', url: 'http://169.254.169.254/latest/meta-data' }] }, brand),
    (e: unknown) => e instanceof LaunchRefused && /could not be read: the address 169\.254\.169\.254 is not public/.test(e.message),
  );
  assert.deepEqual(fetched, ['http://169.254.169.254/latest/meta-data']);
  await assert.rejects(service.create({ title: 'Ghost', lang: 'en', channels: [], sources: [{ kind: 'media', sha256: 'c'.repeat(64) }] }, brand), /upload it first/);
  await assert.rejects(service.create({ title: '!!!', lang: 'en', channels: [], sources: [{ kind: 'text', text: 'x' }] }, brand), /letters or digits/);
  assert.equal((await registry.launches.recent(10)).length, 0, 'no launch was claimed');
});

test('a title launched already is refused; a failed one is asked for again with the new sources', async () => {
  const { registry, service } = await setup();
  const first = await service.create({ title: 'Why I self-host', lang: 'en', channels: [], sources: [{ kind: 'text', text: 'one' }] }, brand);
  await assert.rejects(service.create({ title: 'Why I self-host', lang: 'en', channels: [], sources: [{ kind: 'text', text: 'two' }] }, brand), (e: unknown) => e instanceof LaunchRefused && e.reason === 'launched');
  await registry.launches.setStatus(first.id, 'failed', 'the AI failed');
  const again = await service.create({ title: 'Why I self-host', lang: 'en', channels: ['bluesky'], sources: [{ kind: 'text', text: 'two' }] }, brand);
  assert.equal(again.id, first.id);
  assert.equal(again.status, 'detected');
  assert.deepEqual((await registry.sources.list(again.id)).map((r) => r.text), ['two']);
});

test('an upload while the media store is unavailable says why', async () => {
  const registry = await memoryRegistry();
  const service = new SourcesService({
    launchService: { claimManual: async () => Promise.reject(new Error('unused')) },
    launches: registry.launches,
    sources: registry.sources,
    launchesRepo: 'yeyo11/launches',
    media: unavailableMediaStore('the launch-media flag is off (SHIPCAST_FLAGS)'),
    fetchPage: async () => Promise.reject(new Error('unused')),
  });
  await assert.rejects(service.upload(PNG), /launch-media flag is off/);
  await assert.rejects(service.upload(new Uint8Array(ascii('<svg/>'))), /only PNG/);
});
