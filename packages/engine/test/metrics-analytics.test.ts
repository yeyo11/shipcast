import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AnalyticsMany } from '@shipcast/connectors';
import { Brand } from '@shipcast/schema';
import { batchReader, collectHourly, type MetricSources } from '../src/index.ts';
import { aPublishedLaunch, memoryRegistry } from '../src/testing/index.ts';

/*
 * A channel's analytics (YouTube Analytics) read apart from its counters: once a day for every live
 * piece, whatever the hourly reads do, and asked for once a day even when refused, so a connection
 * made before the permission was asked for says why once a day and never stops the counters.
 */

const brand = Brand.parse({ id: 'personal', displayName: 'Me', site: 'https://josegarrido.dev', github: 'yeyo11' });
const HOUR = 3_600_000;

async function videos() {
  const registry = await memoryRegistry();
  const { launch, posts } = await aPublishedLaunch(registry, [
    { channel: 'youtube', kind: 'post:short', externalId: 'short1' },
    { channel: 'youtube', kind: 'post:video', externalId: 'video1' },
  ]);
  return { registry, launch, posts };
}

function youtube(analytics: (pieces: ReadonlyArray<{ id: string; since: string }>, until: string) => Promise<AnalyticsMany>) {
  const counts = async (ids: string[]) => new Map(ids.map((id) => [id, { views: 10, likes: 1 }]));
  const asked: Array<{ pieces: ReadonlyArray<{ id: string; since: string }>; until: string }> = [];
  const sources: MetricSources = {
    posts: {
      youtube: {
        metrics: async (id) => (await counts([id])).get(id)!,
        read: batchReader(counts).read,
        analytics: async (pieces, until) => {
          asked.push({ pieces, until });
          return analytics(pieces, until);
        },
      },
    },
  };
  return { sources, asked };
}

test('the analytics are read once a day for every live video, from its launch day, and kept on each piece', async () => {
  const { registry, launch, posts } = await videos();
  const { sources, asked } = youtube(async (pieces) => new Map(pieces.map((p) => [p.id, { watchMinutes: p.id === 'short1' ? 12 : 30, avgViewPercent: 61.5 }])));
  const t0 = new Date('2026-11-03T09:00:00.000Z');
  assert.deepEqual((await collectHourly(registry, brand, sources, t0)).problems, []);
  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0], { pieces: [{ id: 'short1', since: launch.createdAt.slice(0, 10) }, { id: 'video1', since: launch.createdAt.slice(0, 10) }], until: '2026-11-03' });

  const of = async (postId: number, name: string) => (await registry.metrics.postMetrics(postId)).find((m) => m.name === name)?.value;
  assert.deepEqual([await of(posts[0]!.id, 'watchMinutes'), await of(posts[1]!.id, 'watchMinutes'), await of(posts[1]!.id, 'avgViewPercent'), await of(posts[1]!.id, 'views')], [12, 30, 61.5, 10]);

  // The counters hourly, the analytics not before a day
  await collectHourly(registry, brand, sources, new Date(t0.getTime() + HOUR));
  assert.equal(asked.length, 1);
  await collectHourly(registry, brand, sources, new Date(t0.getTime() + 24 * HOUR));
  assert.equal(asked.length, 2);
});

test('analytics refused for a missing permission: said once, the counters still read, asked again only the next day', async () => {
  const { registry, launch } = await videos();
  const { sources, asked } = youtube(async () => {
    throw new Error('YouTube Analytics was not granted to this connection (yt-analytics.readonly): connect YouTube again');
  });
  const t0 = new Date('2026-11-03T09:00:00.000Z');
  const first = await collectHourly(registry, brand, sources, t0);
  assert.equal(first.problems.length, 1);
  assert.match(first.problems[0]!, /^youtube analytics: .*yt-analytics\.readonly/);
  assert.ok((await registry.metrics.latestMetrics(launch.id)).some((m) => m.name === 'views'), 'the views and likes are recorded all the same');

  const second = await collectHourly(registry, brand, sources, new Date(t0.getTime() + HOUR));
  assert.deepEqual(second.problems, [], 'not asked again within the day');
  assert.equal(asked.length, 1);
});

test('analytics a network stopped part way: what was read is kept and the problem said, the rest asked for the next hour, not the next day', async () => {
  const { registry, posts } = await videos();
  let limited = true;
  const { sources, asked } = youtube(async (pieces) => {
    const out: AnalyticsMany = new Map([[pieces[0]!.id, { watchMinutes: 5 }]]);
    if (limited && pieces.length > 1) {
      out.unread = pieces.slice(1).map((p) => p.id);
      out.problems = ['read the analytics: 429 rate limited'];
    }
    return out;
  });
  const t0 = new Date('2026-11-03T09:00:00.000Z');
  const first = await collectHourly(registry, brand, sources, t0);
  assert.deepEqual(first.problems, ['youtube analytics: read the analytics: 429 rate limited']);
  const of = async (postId: number) => (await registry.metrics.postMetrics(postId)).find((m) => m.name === 'watchMinutes')?.value;
  assert.deepEqual([await of(posts[0]!.id), await of(posts[1]!.id)], [5, undefined]);

  limited = false;
  await collectHourly(registry, brand, sources, new Date(t0.getTime() + HOUR));
  assert.deepEqual(asked.map((a) => a.pieces.map((p) => p.id)), [['short1', 'video1'], ['video1']], 'only the piece not reached');
  assert.equal(await of(posts[1]!.id), 5);

  await collectHourly(registry, brand, sources, new Date(t0.getTime() + 2 * HOUR));
  assert.equal(asked.length, 2, 'every piece read: nothing more until the next day');
});
