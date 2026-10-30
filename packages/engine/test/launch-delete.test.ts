import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Brand, type Channel } from '@shipcast/schema';
import { DeletionRefused, inTransaction, LaunchDeletionService, publishLaunch, sha256Hex, type PostKind, type PostOutcome } from '../src/index.ts';
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
