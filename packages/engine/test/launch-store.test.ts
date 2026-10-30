import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sql } from 'drizzle-orm';
import { draftFile, type ContentPack } from '@shipcast/schema';
import {
  deliverDrafts,
  DraftSnapshotService,
  LaunchService,
  LaunchStoreService,
  launchStoreKey,
  publishLaunch,
  storedFile,
  unavailableMediaStore,
  type Launch,
  type LaunchServiceDeps,
  type MediaStore,
  type PipelineDeps,
  type PublishDeps,
} from '../src/index.ts';
import { FakeGitHub, memoryRegistry, MemoryMediaStore } from '../src/testing/index.ts';

const LAUNCHES = 'yeyo11/launches';
const D = 'launches/claudio/v1.0.0';
const BRANCH = 'launch/claudio-v1.0.0';
const NOW = new Date('2026-10-30T12:00:00Z');
const LAUNCH_YML = 'enabled: true\nbrand: personal\npublishing:\n  reddit: approval\nreddit:\n  subreddits: [selfhosted]\n';
const pack = {
  schemaVersion: 1,
  kind: 'launch',
  project: { name: 'claudio', repo: 'https://github.com/yeyo11/claudio', version: 'v1.0.0' },
  analysis: { summary: 's', implemented: ['x'], planned: [], documentedOnly: [], limitations: [] },
  bluesky: { lang: 'en', text: 'hello' },
} as unknown as ContentPack;

const BLUESKY = `${D}/${draftFile('bluesky').name}`;
const REDDIT = `${D}/${draftFile('reddit', 'selfhosted').name}`;
const ARTICLE = 'src/content/posts/en/claudio.md';
const files = [
  { path: ARTICLE, content: '---\ntitle: "claudio"\n---\n\nThe article.\n' },
  { path: BLUESKY, content: '# Bluesky\n\n> **Approval:** published when this pull request is merged. Edit it here if it needs changes.\n\nhello\n' },
  { path: REDDIT, content: '# Reddit: r/selfhosted\n\n> **Approval:** published when this pull request is merged. Edit it here if it needs changes.\n\nTitle\n\nBody\n' },
  { path: `${D}/pack.json`, content: `${JSON.stringify(pack, null, 2)}\n` },
  { path: `public/${D}/og.png`, bytes: new Uint8Array([1, 2, 3]) },
  { path: 'public/covers/claudio.jpg', bytes: new Uint8Array([4, 5]) },
  { path: 'projects.yml', content: 'claudio:\n  cover: /covers/claudio.jpg\n' },
];

async function setup(options: { store?: boolean; media?: MediaStore } = {}) {
  const registry = await memoryRegistry();
  const github = new FakeGitHub();
  github.setFile('yeyo11/claudio', '.github/launch.yml', LAUNCH_YML, 'v1.0.0');
  const { launch } = await registry.launches.claim({ repo: 'yeyo11/claudio', ref: 'v1.0.0', trigger: 'release', kind: 'launch', brand: 'personal' });
  const media = options.media ?? new MemoryMediaStore();
  const store = new LaunchStoreService({ registry, media, github, launchesRepo: LAUNCHES, now: () => NOW });
  const deps = { github, registry, launchesRepo: LAUNCHES, ...(options.store !== false && { launchStore: store }) } as unknown as PipelineDeps;
  const deliver = async (direct = false) => {
    const result = await deliverDrafts(launch, deps, { files, branch: BRANCH, title: 't', body: 'b', message: 'm', source: { pack, configText: LAUNCH_YML } }, { direct });
    assert.ok(result.ok);
    return result.launch;
  };
  const launches = (more: Partial<LaunchServiceDeps> = {}) =>
    new LaunchService({ launches: registry.launches, claims: deps, github: github as unknown as LaunchServiceDeps['github'], ...more });
  return { registry, github, launch, media, store, deps, deliver, launches };
}

async function nothingStored(registry: Awaited<ReturnType<typeof setup>>['registry'], launchId: number) {
  assert.equal(await registry.launchStore.currentPack(launchId), undefined);
  assert.deepEqual(await registry.launchStore.drafts(launchId), []);
  assert.deepEqual(await registry.launchStore.media(launchId, ['/covers/claudio.jpg']), []);
  assert.deepEqual((await registry.launchStore.channels(launchId)).rows, []);
  assert.equal(await registry.launchStore.approval(launchId), undefined);
  assert.equal(await registry.cursors.cursor(launchStoreKey(launchId)), undefined);
}

test('characterisation, flag off: the drafts go to a pull request, an edit is a commit on its branch, and the launch model tables stay empty', async () => {
  const { registry, github, launch, deliver, launches } = await setup({ store: false });
  const drafted = await deliver();
  assert.equal(drafted.status, 'drafted');
  assert.equal(drafted.detail, `https://github.com/${LAUNCHES}/pull/1`);
  assert.deepEqual(
    github.opened[0]?.files.map((f) => f.path),
    files.map((f) => f.path),
  );
  assert.equal('source' in (github.opened[0] ?? {}), false, 'what the drafts were made from is not handed to GitHub');

  const snapshots = new DraftSnapshotService({ github, registry, launchesRepo: LAUNCHES });
  await snapshots.refresh(drafted);
  await launches({ drafts: snapshots }).editDraft(launch.id, BLUESKY, 'new text');
  assert.deepEqual(github.updates, [{ repo: LAUNCHES, branch: BRANCH, path: BLUESKY, content: 'new text\n', message: 'Edit Bluesky in Shipcast' }]);
  assert.equal((await snapshots.get(launch.id))?.files.find((f) => f.path === BLUESKY)?.content, 'new text\n', 'the snapshot has the edit at once, as before');
  await nothingStored(registry, launch.id);
});

test('the drafts are mapped by path: articles and channel drafts are drafts, pack.json a pack, public/ media, projects.yml the site', () => {
  const launch = { repo: 'yeyo11/claudio', ref: 'v1.0.0' };
  assert.deepEqual(storedFile(launch, ARTICLE), { kind: 'draft', channel: 'blog', piece: 'article:en' });
  assert.deepEqual(storedFile(launch, BLUESKY), { kind: 'draft', channel: 'bluesky', piece: 'post' });
  assert.deepEqual(storedFile(launch, REDDIT), { kind: 'draft', channel: 'reddit', piece: 'selfhosted' });
  assert.deepEqual(storedFile(launch, `${D}/release-notes.md`), { kind: 'draft', channel: 'releaseNotes', piece: 'notes' });
  assert.deepEqual(storedFile(launch, `${D}/pack.json`), { kind: 'pack' });
  assert.deepEqual(storedFile(launch, `public/${D}/instagram-02.mp4`), { kind: 'media', publicPath: `/${D}/instagram-02.mp4`, role: 'carousel', shared: false });
  assert.deepEqual(storedFile(launch, 'public/covers/claudio.jpg'), { kind: 'media', publicPath: '/covers/claudio.jpg', role: 'cover', shared: true });
  assert.deepEqual(storedFile(launch, 'projects.yml'), { kind: 'site' });
  assert.deepEqual(storedFile({ repo: LAUNCHES, ref: 'article:hola' }, 'articles/hola/launch.yml'), { kind: 'channels' });
});

test('with launch-store, opening the pull request also stores the pack, the channels, each draft as its first version and the media', async () => {
  const { registry, launch, media, deliver } = await setup();
  await deliver();
  assert.deepEqual((await registry.launchStore.currentPack(launch.id))?.pack, JSON.parse(JSON.stringify(pack)));
  const channels = await registry.launchStore.channels(launch.id);
  assert.equal(channels.source, LAUNCH_YML);
  assert.deepEqual(
    channels.rows.find((r) => r.channel === 'reddit'),
    { channel: 'reddit', mode: 'approval', options: { subreddits: ['selfhosted'] }, note: null },
  );
  const drafts = await registry.launchStore.drafts(launch.id);
  assert.deepEqual(
    drafts.map((d) => [d.channel, d.piece, d.n, d.origin, d.fields.path, d.body]),
    [
      ['blog', 'article:en', 1, 'ai', ARTICLE, files[0]!.content],
      ['bluesky', 'post', 1, 'ai', BLUESKY, files[1]!.content],
      ['reddit', 'selfhosted', 1, 'ai', REDDIT, files[2]!.content],
    ],
  );
  const rows = await registry.launchStore.media(launch.id, ['/covers/claudio.jpg']);
  assert.deepEqual(
    rows.map((m) => [m.launchId, m.role, m.publicPath, m.mime, m.kind, m.bytes, m.storage]),
    [
      [launch.id, 'og', `/${D}/og.png`, 'image/png', 'image', 3, 'memory'],
      [null, 'cover', '/covers/claudio.jpg', 'image/jpeg', 'image', 2, 'memory'],
    ],
    "the project's cover belongs to no launch",
  );
  assert.equal((media as MemoryMediaStore).objects.size, 2);
  assert.equal(await registry.cursors.cursor(launchStoreKey(launch.id)), undefined, 'the copy agrees with what was pushed: nothing to report');
});

test('media the store cannot keep are reported, and the drafts pull request is opened all the same', async () => {
  const { registry, github, launch, store, deliver } = await setup({ media: unavailableMediaStore('the launch-media flag is off (SHIPCAST_FLAGS)') });
  const drafted = await deliver();
  assert.equal(drafted.status, 'drafted');
  assert.equal(github.opened.length, 1);
  const report = await store.report(launch.id);
  assert.equal(report?.at, NOW.toISOString());
  assert.deepEqual(report?.differences, [
    '2 media files not stored: the media store is not available: the launch-media flag is off (SHIPCAST_FLAGS)',
    `public/${D}/og.png: no media in the database`,
    'public/covers/claudio.jpg: no media in the database',
  ]);
  assert.equal((await registry.launchStore.drafts(launch.id)).length, 3, 'the texts are stored whatever happened to the media');
});

test('a shadow write that fails is reported, never thrown: the draft goes on', async () => {
  const { registry, github, launch, deps } = await setup();
  const broken = Object.assign(Object.create(registry.launchStore) as typeof registry.launchStore, {
    addPack: async () => {
      throw new Error('the database is down');
    },
  });
  const store = new LaunchStoreService({ registry: { launchStore: broken, cursors: registry.cursors }, media: new MemoryMediaStore(), github, launchesRepo: LAUNCHES });
  const result = await deliverDrafts(launch, { ...deps, launchStore: store }, { files, branch: BRANCH, title: 't', body: 'b', message: 'm', source: { pack, configText: LAUNCH_YML } }, {});
  assert.ok(result.ok);
  assert.deepEqual((await store.report(launch.id))?.differences, ['the shadow write failed: the database is down']);

  const throwing = { drafted: async () => Promise.reject(new Error('boom')), merged: async () => [] };
  const again = await setup();
  const still = await deliverDrafts(again.launch, { ...again.deps, launchStore: throwing }, { files, branch: BRANCH, title: 't', body: 'b', message: 'm', source: { pack, configText: LAUNCH_YML } }, {});
  assert.ok(still.ok, 'even a store that throws does not fail the delivery');
});

test('drafts committed straight onto main are stored as committed, and approved', async () => {
  const { registry, launch, deliver } = await setup();
  const drafted = await deliver(true);
  assert.match(drafted.detail ?? '', /^direct:sha1 /);
  const drafts = await registry.launchStore.drafts(launch.id);
  assert.match(drafts.find((d) => d.channel === 'bluesky')?.body ?? '', /Published directly/);
  const approval = await registry.launchStore.approval(launch.id);
  assert.equal(approval?.by, 'shipcast');
  assert.equal(approval?.note, 'committed straight onto main as sha1');
  assert.deepEqual(approval?.versions, Object.fromEntries(drafts.map((d) => [String(d.id), d.versionId])));
  const [row] = await registry.queries.selectRows<{ approved_at: string | null }>(sql`SELECT approved_at FROM launches WHERE id = ${launch.id}`);
  assert.equal(row?.approved_at, approval?.at);
});

test("an edit in Shipcast is the owner's version of the draft; the same text again adds none", async () => {
  const { registry, launch, store, deliver, launches } = await setup();
  await deliver();
  await launches({ launchStore: store }).editDraft(launch.id, BLUESKY, 'new text');
  await launches({ launchStore: store }).editDraft(launch.id, BLUESKY, 'new text\n');
  const bluesky = (await registry.launchStore.drafts(launch.id)).find((d) => d.channel === 'bluesky');
  assert.deepEqual([bluesky?.n, bluesky?.origin, bluesky?.body], [2, 'owner', 'new text\n']);
});

test('reading the pull request turns an edit made on GitHub into a version, the merge into the approval, and checks the copy', async () => {
  const { registry, github, launch, store, deliver } = await setup();
  const drafted = await deliver();
  github.setFile(LAUNCHES, BLUESKY, 'edited on GitHub\n', BRANCH);
  await github.mergePullRequest(LAUNCHES, 1, 't');
  Object.assign(github.pulls.get(`${LAUNCHES}#1`)!, { mergedBy: 'yeyo11', mergedAt: '2026-10-30T11:00:00.000Z' });

  const snapshots = new DraftSnapshotService({ github, registry, launchesRepo: LAUNCHES, launchStore: store });
  await snapshots.refresh(drafted);
  const bluesky = (await registry.launchStore.drafts(launch.id)).find((d) => d.channel === 'bluesky');
  assert.deepEqual([bluesky?.n, bluesky?.origin, bluesky?.body], [2, 'owner', 'edited on GitHub\n']);
  const approval = await registry.launchStore.approval(launch.id);
  assert.deepEqual([approval?.by, approval?.at, approval?.note], ['yeyo11', '2026-10-30T11:00:00.000Z', `merged https://github.com/${LAUNCHES}/pull/1`]);
  assert.equal(approval?.versions[String(bluesky?.id)], bluesky?.versionId, 'the approval names the version merged');
  assert.equal(await store.report(launch.id), undefined, 'the copy agrees with the merged pull request');

  // Read again, nothing new: no version, no second approval
  await snapshots.refresh(drafted);
  assert.equal((await registry.launchStore.drafts(launch.id)).find((d) => d.channel === 'bluesky')?.n, 2);
  const [count] = await registry.queries.selectRows<{ n: number }>(sql`SELECT count(*)::int AS n FROM approvals WHERE launch_id = ${launch.id}`);
  assert.equal(count?.n, 1);
});

test('the check reports what the copy lacks, and what changed in the launch.yml it was read from', async () => {
  const { registry, github, launch, store, deliver } = await setup();
  const drafted = await deliver();
  const mastodon = `${D}/${draftFile('mastodon').name}`;
  github.pulls.get(`${LAUNCHES}#1`)!.files.push(mastodon);
  github.setFile(LAUNCHES, mastodon, '# Mastodon\n\ntoot\n', BRANCH);
  github.setFile('yeyo11/claudio', '.github/launch.yml', `${LAUNCH_YML}language: es\n`, 'v1.0.0');
  await new DraftSnapshotService({ github, registry, launchesRepo: LAUNCHES, launchStore: store }).refresh(drafted);
  assert.deepEqual((await store.report(launch.id))?.differences, [`${mastodon}: no draft in the database`, 'launch.yml of yeyo11/claudio: the database\'s channels were read from another version']);
  assert.equal((await registry.launchStore.drafts(launch.id)).length, 3, 'a draft the copy lacks is reported, not filled in');
  assert.ok(await registry.cursors.cursor(launchStoreKey(launch.id)));
});

test('a launch the shadow write never stored is left alone by the reads and the merge', async () => {
  const { registry, github, launch, store, deliver } = await setup({ store: false });
  const drafted = await deliver();
  await github.mergePullRequest(LAUNCHES, 1, 't');
  await new DraftSnapshotService({ github, registry, launchesRepo: LAUNCHES, launchStore: store }).refresh(drafted);
  assert.deepEqual(await store.merged(drafted), []);
  await nothingStored(registry, launch.id);
});

test('publishing that finds the drafts merged records the approval once, with or without the snapshot', async () => {
  const { registry, github, launch, store, deliver } = await setup();
  const drafted = await deliver();
  await github.mergePullRequest(LAUNCHES, 1, 't');
  Object.assign(github.pulls.get(`${LAUNCHES}#1`)!, { mergedBy: 'yeyo11' });
  assert.deepEqual(await store.merged(drafted), []);
  assert.equal((await registry.launchStore.approval(launch.id))?.by, 'yeyo11');
  const reads = github.calls.length;
  assert.deepEqual(await store.merged(drafted), []);
  assert.equal(github.calls.length, reads, 'an approved launch is not read again');
});

test('publishing tells the shadow write once the drafts are approved, and not while they wait', async () => {
  const registry = await memoryRegistry();
  const github = new FakeGitHub();
  const { launch } = await registry.launches.claim({ repo: 'yeyo11/claudio', ref: 'v1.0.0', trigger: 'release', kind: 'launch', brand: 'personal' });
  const pr = github.addPullRequest({ repo: LAUNCHES, number: 3, branch: BRANCH });
  const drafted = await registry.launches.setStatus(launch.id, 'drafted', `https://github.com/${LAUNCHES}/pull/3`);
  const told: Launch[] = [];
  const deps = { github, registry, launchesRepo: LAUNCHES, publishers: {}, launchStore: { merged: async (l: Launch) => (told.push(l), []) } } as unknown as PublishDeps;
  assert.equal((await publishLaunch(drafted, { site: 'https://josegarrido.dev' } as never, deps)).state, 'waiting');
  assert.equal(told.length, 0);
  pr.state = 'merged';
  const result = await publishLaunch(drafted, { site: 'https://josegarrido.dev' } as never, deps);
  assert.deepEqual([result.state, 'reason' in result && result.reason], ['waiting', `${D}/pack.json is not on the default branch yet`]);
  assert.deepEqual(told.map((l) => l.id), [launch.id]);
});
