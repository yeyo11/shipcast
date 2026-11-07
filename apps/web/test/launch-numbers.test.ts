import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryRegistry, publishedAgo } from '@shipcast/engine/testing';
import { launchNumbers } from '../src/server/launch-summary.server.ts';

test('a launch’s numbers carry when each total was last read, per launch and per channel', async () => {
  const registry = await memoryRegistry();
  const { launch } = await registry.launches.claim({ repo: 'yeyo11/claudio', ref: 'v1.0.0', trigger: 'release', kind: 'launch', brand: 'personal' });
  await registry.launches.setStatus(launch.id, 'published');
  const { post } = await registry.posts.recordPost({ launchId: launch.id, channel: 'devto', kind: 'post', accountId: null, externalId: 'd1', url: 'https://dev.to/x' });
  const moves = { unchangedMovesCheck: true };
  await registry.metrics.recordMetrics(launch.id, 'devto', { views: 10 }, new Date('2026-11-07T11:00:00Z'), post.id, moves);
  // Read again unchanged: the reading's check moves, and so does its age
  await registry.metrics.recordMetrics(launch.id, 'devto', { views: 10 }, new Date('2026-11-07T11:15:00Z'), post.id, moves);
  await registry.metrics.recordMetrics(launch.id, 'search', { clicks: 2 }, new Date('2026-11-07T03:00:00Z'), null, moves);
  const numbers = (await launchNumbers(registry, [launch])).get(launch.id)!;
  assert.deepEqual(numbers.ages?.views, { readAt: '2026-11-07T11:15:00.000Z' });
  assert.deepEqual(numbers.ages?.clicks, { readAt: '2026-11-07T03:00:00.000Z', lag: 'Search Console lags 2–3 days' });
  assert.deepEqual(numbers.channels.devto?.ages?.views, { readAt: '2026-11-07T11:15:00.000Z' });
  assert.equal(numbers.updated?.readAt, '2026-11-07T11:15:00.000Z', 'the newest read among its totals');
});

test('a launch whose only stale source is a Discord message past its 30 days is not overdue', async () => {
  const registry = await memoryRegistry();
  const { launch } = await registry.launches.claim({ repo: 'yeyo11/claudio', ref: 'v2.0.0', trigger: 'release', kind: 'launch', brand: 'personal' });
  await registry.launches.setStatus(launch.id, 'published');
  const { post } = await registry.posts.recordPost({ launchId: launch.id, channel: 'discord', kind: 'post', accountId: null, externalId: '1', url: null });
  const now = Date.now();
  await publishedAgo(registry, post.id, new Date(now - 40 * 86_400_000));
  await registry.metrics.recordMetrics(launch.id, 'discord', { reactions: 2 }, new Date(now - 35 * 86_400_000), post.id);
  const numbers = (await launchNumbers(registry, [launch])).get(launch.id)!;
  assert.deepEqual(numbers.updated?.overdue, []);
});
