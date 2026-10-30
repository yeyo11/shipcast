import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Brand, type Channel } from '@shipcast/schema';
import { appBlogKey, DeletionRefused, inTransaction, LaunchDeletionService, publishLaunch, sha256Hex, type PostKind, type PostOutcome } from '../src/index.ts';
import { FakeGitHub, memoryRegistry, MemoryMediaStore } from '../src/testing/index.ts';

/*
 * The launch model's seventh phase, deletion (docs/launch-delete.md): a launch never published is
 * removed with its rows, a published one hidden with its posts kept unless the owner picks channels,
 * and removing the article says how many posts still link it.
 */

const brand = Brand.parse({ id: 'personal', displayName: 'Me', site: 'https://josegarrido.dev', github: 'yeyo11' });
const LAUNCHES = 'yeyo11/launches';

async function setup(options: { pullRequestState?: 'open' | 'merged' | 'closed' } = {}) {
  const registry = await memoryRegistry();
  const github = new FakeGitHub({ ...(options.pullRequestState && { pullRequestState: options.pullRequestState }) });
  const media = new MemoryMediaStore();
  const asked: Array<{ launchId: number; channels: readonly Channel[] | undefined }> = [];
  // PostService's deleteMany, as the networks would answer: every piece out on a channel named is gone, Instagram's stay
  const posts = {
    async deleteMany(launchId: number, selection: unknown): Promise<PostOutcome[]> {
      const channels = selection as readonly Channel[] | undefined;
      asked.push({ launchId, channels });
      const outcomes: PostOutcome[] = [];
      for (const p of await registry.posts.posts(launchId)) {
        if (p.status !== 'live' && p.status !== 'edited') continue;
        if (channels && !channels.includes(p.channel)) continue;
        if (p.channel === 'instagram') {
          outcomes.push({ postId: p.id, channel: p.channel, kind: p.kind, ok: false, reason: 'unsupported', problem: 'Instagram cannot delete a published post' });
          continue;
        }
        outcomes.push({ postId: p.id, channel: p.channel, kind: p.kind, ok: true, post: await registry.posts.updatePost(p.id, { status: 'deleted' }) });
      }
      return outcomes;
    },
  };
  const service = new LaunchDeletionService({ registry, inTransaction: (work) => inTransaction(registry, work), posts, github, launchesRepo: LAUNCHES, media });
  const claim = async (ref = 'v1.0.0') => (await registry.launches.claim({ repo: 'yeyo11/claudio', ref, trigger: 'release', kind: 'launch', brand: 'personal' })).launch;
  const post = (launchId: number, channel: Channel, kind: PostKind = 'post', status: 'live' | 'scheduled' = 'live') =>
    registry.posts.recordPost({ launchId, channel, kind, externalId: `${channel}-${kind}`, url: `https://example.com/${channel}/${kind}`, status });
  return { registry, github, media, service, asked, claim, post };
}

test('today: every launch is listed, and nothing removes one', async () => {
  const { registry, claim } = await setup();
  const launch = await claim();
  assert.deepEqual((await registry.launches.recent()).map((l) => l.id), [launch.id]);
  assert.equal(launch.deletedAt, undefined, 'a launch read from the registry carries no deletedAt unless it was deleted');
});

test('a launch never published is removed with its rows; its drafts pull request is closed', async () => {
  const { registry, github, service, claim } = await setup();
  const launch = await claim();
  await registry.launches.setStatus(launch.id, 'drafted', `https://github.com/${LAUNCHES}/pull/7`);
  await registry.launchStore.replaceChannels(launch.id, [{ channel: 'blog', mode: 'approval' }], 'enabled: true\nbrand: personal\n');

  const plan = await service.plan(launch.id);
  assert.equal(plan.mode, 'removed');
  assert.deepEqual(plan.channels, []);
  const result = await service.delete(launch.id, { by: 'yeyo11' });
  assert.equal(result.mode, 'removed');
  assert.deepEqual(result.problems, []);
  assert.equal(await registry.launches.get(launch.id), undefined);
  assert.deepEqual((await registry.launchStore.channels(launch.id)).rows, [], 'the launch model’s rows go with it');
  assert.deepEqual(github.called('closePreview'), [[LAUNCHES, 7, 'launch/claudio-v1.0.0']]);
  assert.deepEqual(
    { mode: result.deletion.mode, key: result.deletion.dedupeKey, by: result.deletion.by },
    { mode: 'removed', key: 'github-release:yeyo11/claudio@v1.0.0', by: 'yeyo11' },
  );
  assert.equal(await registry.launchDeletions.removed('github-release:yeyo11/claudio@v1.0.0'), true, 'a trigger finds it removed');
  assert.equal(await registry.launchDeletions.removed('github-release:yeyo11/claudio@v2.0.0'), false);
});

test('a removed launch’s media bytes go from the store unless another launch names them', async () => {
  const { registry, media, service, claim } = await setup();
  const launch = await claim();
  const other = await claim('v2.0.0');
  await registry.launches.setStatus(launch.id, 'failed', 'the analysis failed');
  const own = await media.put(new TextEncoder().encode('own'), 'image/png');
  const shared = await media.put(new TextEncoder().encode('shared'), 'image/png');
  const row = (launchId: number, stored: { sha256: string; key: string; bytes: number }, path: string) =>
    registry.launchStore.addMedia({ launchId, sha256: stored.sha256, kind: 'image', mime: 'image/png', bytes: stored.bytes, storage: 'memory', path: stored.key, role: 'og', publicPath: path });
  await row(launch.id, own, '/a.png');
  await row(launch.id, shared, '/b.png');
  await row(other.id, shared, '/c.png');

  await service.delete(launch.id);
  assert.equal(await media.has(own.key), false);
  assert.equal(await media.has(shared.key), true, 'still named by the other launch');
  assert.equal(sha256Hex(new TextEncoder().encode('own')), own.sha256);
});

test('a launch whose drafts are being written cannot be deleted yet; a deleted one not again', async () => {
  const { registry, service, claim, post } = await setup();
  const launch = await claim();
  await registry.launches.setStatus(launch.id, 'generating');
  await assert.rejects(service.delete(launch.id), (error: unknown) => error instanceof DeletionRefused && error.reason === 'state');
  await registry.launches.setStatus(launch.id, 'published');
  await post(launch.id, 'bluesky');
  await service.delete(launch.id);
  await assert.rejects(service.delete(launch.id), /deleted already/);
  await assert.rejects(service.delete(9999), (error: unknown) => error instanceof DeletionRefused && error.reason === 'not_found');
});

test('a published launch is hidden: gone from the lists, its posts kept on the networks by default', async () => {
  const { registry, service, asked, claim, post } = await setup();
  const launch = await claim();
  await registry.launches.setStatus(launch.id, 'published');
  await post(launch.id, 'blog', 'article:en');
  await post(launch.id, 'bluesky');

  const plan = await service.plan(launch.id);
  assert.equal(plan.mode, 'hidden');
  assert.deepEqual(plan.channels, [
    { channel: 'blog', out: 1, remove: 'yes' },
    { channel: 'bluesky', out: 1, remove: 'yes' },
  ]);
  const result = await service.delete(launch.id);
  assert.equal(result.mode, 'hidden');
  assert.deepEqual(asked, [], 'nothing deleted on the networks unless asked');
  assert.ok((await registry.posts.posts(launch.id)).every((p) => p.status === 'live'));

  const hidden = (await registry.launches.get(launch.id))!;
  assert.ok(hidden.deletedAt, 'still read by id, with when it was deleted');
  assert.deepEqual(await registry.launches.recent(), []);
  assert.equal((await registry.launches.launchList()).total, 0);
  assert.deepEqual((await registry.launches.launchFacets()).repos, []);
  assert.deepEqual((await registry.launches.launchesPage({ limit: 10 })).launches, []);
  assert.equal(await registry.launchDeletions.removed('github-release:yeyo11/claudio@v1.0.0'), false, 'hidden, not removed: its row keeps the claim');
  assert.equal((await registry.launches.claim({ repo: 'yeyo11/claudio', ref: 'v1.0.0', trigger: 'release', kind: 'launch', brand: 'personal' })).claimed, false);
});

test('the channels ticked are deleted on their networks; removing the article warns how many posts still link it', async () => {
  const { registry, service, asked, claim, post } = await setup();
  const launch = await claim();
  await registry.launches.setStatus(launch.id, 'published');
  await post(launch.id, 'blog', 'article:en');
  await post(launch.id, 'bluesky');
  await post(launch.id, 'mastodon');
  await post(launch.id, 'instagram');

  assert.equal((await service.plan(launch.id)).articleLinks, 3);
  await assert.rejects(service.delete(launch.id, { channels: ['reddit'] }), /nothing of this launch is out on reddit/);
  const result = await service.delete(launch.id, { channels: ['blog', 'mastodon'], by: 'api' });
  assert.deepEqual(asked, [{ launchId: launch.id, channels: ['blog', 'mastodon'] }]);
  assert.deepEqual(result.outcomes.map((o) => [o.channel, o.ok]), [['blog', true], ['mastodon', true]]);
  assert.equal(result.warning, '2 posts still link to the article, which is gone: their links are broken now.');
  assert.deepEqual({ channels: result.deletion.channels, links: result.deletion.articleLinks, by: result.deletion.by }, { channels: ['blog', 'mastodon'], links: 2, by: 'api' });
  const left = (await registry.posts.posts(launch.id)).filter((p) => p.status === 'live').map((p) => p.channel).sort();
  assert.deepEqual(left, ['bluesky', 'instagram']);
});

test('a hidden launch publishes nothing more: its waiting pieces are dropped and publishing skips it', async () => {
  const { registry, github, service, claim, post } = await setup();
  const launch = await claim();
  await registry.launches.setStatus(launch.id, 'drafted', `https://github.com/${LAUNCHES}/pull/3`);
  await post(launch.id, 'blog', 'article:en');
  const waiting = await post(launch.id, 'bluesky', 'post', 'scheduled');
  await service.delete(launch.id);
  assert.equal(await registry.posts.post(waiting.post.id), undefined, 'the scheduled piece is dropped');
  const hidden = (await registry.launches.get(launch.id))!;
  const result = await publishLaunch(hidden, brand, { github, registry, launchesRepo: LAUNCHES, publishers: {} });
  assert.equal(result.state, 'skipped');
  assert.deepEqual(github.called('pullRequestState'), [], 'not even GitHub is asked');
});

test('a merged drafts pull request put the article on the site: such a launch is hidden, not removed', async () => {
  const { registry, service, claim } = await setup({ pullRequestState: 'merged' });
  const launch = await claim();
  await registry.launches.setStatus(launch.id, 'drafted', `https://github.com/${LAUNCHES}/pull/5`);
  assert.equal((await service.plan(launch.id)).mode, 'hidden');
});

test('a launch Shipcast holds whose article was committed is hidden, not removed, even where app-review is off', async () => {
  // The service is built without app-review (the flag off in this process): until the fix it asked
  // app-review alone, so the launch was "never published" and removed, its article left on the site
  const { registry, service, claim } = await setup();
  const launch = await claim();
  await registry.launches.setModel(launch.id, 'app');
  await registry.launches.setStatus(launch.id, 'drafted', null);
  await registry.cursors.setCursor(appBlogKey(launch.id), JSON.stringify({ sha: 'abc123', at: '2026-10-30T10:00:00.000Z' }));
  assert.equal((await service.plan(launch.id)).mode, 'hidden');

  // A commit still pending (its record not written yet) may be on main already: hidden as well
  const other = await claim('v2.0.0');
  await registry.launches.setModel(other.id, 'app');
  await registry.launches.setStatus(other.id, 'drafted', null);
  await registry.cursors.setCursor(appBlogKey(other.id), JSON.stringify({ pending: { path: 'src/content/posts/en/x.md', content: 'x' } }));
  assert.equal((await service.plan(other.id)).mode, 'hidden');
});

/** The service with a hook run inside the deletion's transaction, before its work: what another worker does meanwhile */
function racing(s: Awaited<ReturnType<typeof setup>>, meanwhile: () => Promise<unknown>) {
  return new LaunchDeletionService({
    registry: s.registry,
    inTransaction: async (work) => {
      await meanwhile();
      return inTransaction(s.registry, work);
    },
    posts: { deleteMany: async () => [] },
    github: s.github,
    launchesRepo: LAUNCHES,
    media: s.media,
  });
}

test('a piece that goes out between the plan and the removal stops it: the launch is not removed', async () => {
  const s = await setup();
  const launch = await s.claim();
  await s.registry.launches.setStatus(launch.id, 'drafted', `https://github.com/${LAUNCHES}/pull/7`);
  const service = racing(s, () => s.post(launch.id, 'bluesky'));
  await assert.rejects(service.delete(launch.id), (error: unknown) => error instanceof DeletionRefused && error.reason === 'state');
  assert.ok(await s.registry.launches.get(launch.id), 'still there, with the piece that went out');
  assert.equal(await s.registry.launchDeletions.removed('github-release:yeyo11/claudio@v1.0.0'), false);
});

test('a piece a worker claimed between the plan and the removal stops it too', async () => {
  const s = await setup();
  const launch = await s.claim();
  await s.registry.launches.setStatus(launch.id, 'drafted', `https://github.com/${LAUNCHES}/pull/7`);
  const service = racing(s, () => s.registry.attempts.claim({ launchId: launch.id, channel: 'bluesky', kind: 'post' }, { holder: 'job-1', leaseMs: 60_000, idempotent: false }));
  await assert.rejects(service.delete(launch.id), /published meanwhile|being published/);
  assert.ok(await s.registry.launches.get(launch.id));
});

test('hiding is one transaction: a failed record leaves the launch shown and its waiting pieces scheduled', async () => {
  const s = await setup();
  const launch = await s.claim();
  await s.registry.launches.setStatus(launch.id, 'published');
  await s.post(launch.id, 'blog', 'article:en');
  const waiting = await s.post(launch.id, 'bluesky', 'post', 'scheduled');
  const service = new LaunchDeletionService({
    registry: s.registry,
    inTransaction: (work) =>
      inTransaction(s.registry, (tx) =>
        work({
          ...tx,
          launchDeletions: Object.assign(Object.create(Object.getPrototypeOf(tx.launchDeletions) as object) as typeof tx.launchDeletions, tx.launchDeletions, {
            record: () => Promise.reject(new Error('the disk is full')),
          }),
        }),
      ),
    posts: { deleteMany: async () => [] },
    github: s.github,
    launchesRepo: LAUNCHES,
  });
  await assert.rejects(service.delete(launch.id), /the disk is full/);
  assert.equal((await s.registry.launches.get(launch.id))!.deletedAt, undefined, 'not hidden');
  assert.equal((await s.registry.posts.post(waiting.post.id))?.status, 'scheduled', 'not unscheduled');
});

test('a launch hidden by another request meanwhile is not hidden and recorded twice', async () => {
  const s = await setup();
  const launch = await s.claim();
  await s.registry.launches.setStatus(launch.id, 'published');
  await s.post(launch.id, 'bluesky');
  const service = racing(s, () => s.registry.launches.hide(launch.id));
  await assert.rejects(service.delete(launch.id), /deleted already/);
  assert.equal((await s.registry.launchDeletions.ofLaunch(launch.id)), undefined);
});

test('publishing stops before the next channel once the launch is deleted mid-run', async () => {
  const registry = await memoryRegistry();
  const { launch: claimed } = await registry.launches.claim({ repo: 'yeyo11/claudio', ref: 'v0.8.2', trigger: 'release', kind: 'launch', brand: 'personal' });
  const launch = await registry.launches.setStatus(claimed.id, 'drafted', `https://github.com/${LAUNCHES}/pull/3`);
  const D = 'launches/claudio/v0.8.2';
  const pack = {
    schemaVersion: 1,
    kind: 'launch',
    project: { name: 'claudio', repo: 'https://github.com/yeyo11/claudio', version: 'v0.8.2' },
    analysis: { summary: 's', implemented: ['x'], planned: [], documentedOnly: [], limitations: [] },
    bluesky: { lang: 'en', text: 'AI bluesky' },
    mastodon: { lang: 'en', text: 'AI mastodon' },
  };
  const github = new FakeGitHub({
    pullRequestState: 'merged',
    files: {
      [`${LAUNCHES}/${D}/pack.json@HEAD`]: JSON.stringify(pack),
      [`${LAUNCHES}/${D}/bluesky.md@HEAD`]: '# Bluesky\n\n> **Approval:** x\n\nbluesky\n',
      [`${LAUNCHES}/${D}/mastodon.md@HEAD`]: '# Mastodon\n\n> **Approval:** x\n\nmastodon\n',
      'yeyo11/claudio/.github/launch.yml@v0.8.2': 'enabled: true\nbrand: personal\n',
    },
  });
  const sent: string[] = [];
  // The owner deletes the launch while Bluesky's post is going out: Mastodon's must not follow it
  const publishers = {
    bluesky: { publish: async () => (sent.push('bluesky'), await registry.launches.hide(launch.id), { externalId: 'b1', url: 'https://bsky.app/b1' }) },
    mastodon: { publish: async () => (sent.push('mastodon'), { externalId: 'm1', url: 'https://mastodon.social/m1' }) },
  };
  const fetchOk = (async () => new Response(new Uint8Array([0xff, 0xd8, 0xff]))) as typeof fetch;
  await publishLaunch(launch, brand, { github, registry, launchesRepo: LAUNCHES, publishers, fetch: fetchOk });
  assert.deepEqual(sent, ['bluesky']);
});
