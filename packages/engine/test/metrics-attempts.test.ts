import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Brand } from '@shipcast/schema';
import { collectHourly, type MetricSources } from '../src/index.ts';
import { aPublishedLaunch, memoryRegistry } from '../src/testing/index.ts';

/*
 * A piece is due by when it was last asked for, answered or not: one the network refuses (a post
 * gone, a story fewer than five saw, insights Meta will not give) is asked again a cadence later,
 * not on every 5-minute run, and does not drag its channel's other pieces with it.
 */

const brand = Brand.parse({ id: 'personal', displayName: 'Me', site: 'https://josegarrido.dev', github: 'yeyo11', languages: { blog: ['en', 'es'] } });
const MINUTE = 60_000;

test('a piece that never answers is asked once a cadence, not on every run', async () => {
  const registry = await memoryRegistry();
  await aPublishedLaunch(registry, [{ channel: 'facebook', externalId: 'fb-1' }]);
  const asked: string[] = [];
  const sources: MetricSources = {
    posts: { facebook: { metrics: async (id) => (asked.push(id), Promise.reject(new Error('Facebook: (#100) insights refused'))) } },
  };
  const t0 = new Date();
  for (let run = 0; run < 6; run++) await collectHourly(registry, brand, sources, new Date(t0.getTime() + run * 5 * MINUTE));
  assert.deepEqual(asked, ['fb-1'], 'six runs in 25 minutes against a 30-minute cadence: asked once');
  await collectHourly(registry, brand, sources, new Date(t0.getTime() + 30 * MINUTE));
  assert.equal(asked.length, 2, 'and again a cadence later');
});

test('a piece answered with nothing does not make its channel’s other pieces due', async () => {
  const registry = await memoryRegistry();
  await aPublishedLaunch(registry, [{ channel: 'bluesky', externalId: 'at://good' }]);
  await aPublishedLaunch(registry, [{ channel: 'bluesky', externalId: 'at://gone' }]);
  const asked: string[][] = [];
  const sources: MetricSources = {
    posts: {
      bluesky: {
        metrics: async () => ({}),
        metricsMany: async (ids: string[]) => (asked.push([...ids].sort()), new Map(ids.filter((id) => id === 'at://good').map((id) => [id, { likes: 1 }]))),
      },
    },
  };
  const t0 = new Date();
  await collectHourly(registry, brand, sources, t0);
  await collectHourly(registry, brand, sources, new Date(t0.getTime() + 2 * MINUTE));
  assert.equal(asked.length, 1, 'the piece with no numbers is not due two minutes later');
});
