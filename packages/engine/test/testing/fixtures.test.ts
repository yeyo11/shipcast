import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aLaunch, aPublishedLaunch, memoryRegistry, withMetrics, withPosts, withScheduled } from '../../src/testing/index.ts';

test('the fixtures write a drafted launch, its pieces in every status, scheduled rows and readings', async () => {
  const registry = await memoryRegistry();
  const drafted = await aLaunch(registry);
  assert.deepEqual([drafted.repo, drafted.ref, drafted.status, drafted.detail], ['yeyo11/claudio', 'v1.0.0', 'drafted', 'https://github.com/yeyo11/launches/pull/3']);
  const [mastodon, devto] = await withPosts(registry, drafted.id, [{ channel: 'mastodon' }, { channel: 'devto', status: 'deleted', accountId: null }]);
  assert.deepEqual([mastodon?.externalId, mastodon?.url, mastodon?.status], ['mastodon-1', 'https://mastodon.example/mastodon-1', 'live']);
  assert.equal(devto?.status, 'deleted');
  const [bluesky] = await withScheduled(registry, drafted.id, { bluesky: new Date('2026-11-04T09:00:00Z') });
  assert.deepEqual([bluesky?.status, bluesky?.scheduledAt], ['scheduled', '2026-11-04T09:00:00.000Z']);
  await assert.rejects(withScheduled(registry, drafted.id, { mastodon: new Date('2026-11-04T09:00:00Z') }), /out already/);

  const { launch, posts } = await aPublishedLaunch(registry, [{ channel: 'blog', kind: 'article:en', externalId: 'claudio', url: 'https://josegarrido.dev/en/claudio/' }], { ref: 'v2.0.0' });
  assert.equal(launch.status, 'published');
  await withMetrics(registry, launch.id, [{ source: 'blog', values: { views: 4 }, postId: posts[0]!.id }]);
  assert.deepEqual((await registry.latestMetrics(launch.id)).map((m) => `${m.source}.${m.name}=${m.value}`), ['blog.views=4']);
});
