import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sql } from 'drizzle-orm';
import { Brand, channelCadence } from '@shipcast/schema';
import { collectHourly, runChecks, TelemetryStore, type MetricSources } from '../src/index.ts';
import { aPublishedLaunch, memoryRegistry } from '../src/testing/index.ts';

/*
 * The reads slow down with age (docs/publishing.md, "Cadences"): a piece at its cadence for a week
 * after it went out, hourly to a month, daily after; a launch's Umami campaign the same by its
 * launch's first piece. So the calls a round makes grow with recent launches, not every launch ever.
 */

const brand = Brand.parse({ id: 'personal', displayName: 'Me', site: 'https://josegarrido.dev', github: 'yeyo11', languages: { blog: ['en', 'es'] } });
const MINUTE = 60_000;
const DAY = 86_400_000;

async function pieceOfAge(registry: Awaited<ReturnType<typeof memoryRegistry>>, externalId: string, days: number, now: Date) {
  const made = await aPublishedLaunch(registry, [{ channel: 'bluesky', externalId }], { ref: `v-${externalId}` });
  await registry.queries.selectRows(sql`UPDATE posts SET published_at = ${new Date(now.getTime() - days * DAY).toISOString()} WHERE id = ${made.posts[0]!.id} RETURNING id`);
  return made;
}

test('a piece is read at its cadence for a week, hourly to a month, daily after', async () => {
  const registry = await memoryRegistry();
  const t0 = new Date();
  await pieceOfAge(registry, 'at://fresh', 1, t0);
  await pieceOfAge(registry, 'at://week', 10, t0);
  await pieceOfAge(registry, 'at://month', 40, t0);
  const asked: string[] = [];
  const sources: MetricSources = { posts: { bluesky: { metrics: async (id) => (asked.push(id), { likes: 1 }) } } };
  const run = async (minutes: number) => {
    asked.length = 0;
    await collectHourly(registry, brand, sources, new Date(t0.getTime() + minutes * MINUTE));
    return [...asked].sort();
  };
  assert.deepEqual(await run(0), ['at://fresh', 'at://month', 'at://week']);
  assert.deepEqual(await run(5), ['at://fresh'], 'five minutes on: only the piece of the week');
  assert.deepEqual(await run(60), ['at://fresh', 'at://week'], 'an hour on: the one of the month too');
  assert.deepEqual(await run(24 * 60), ['at://fresh', 'at://month', 'at://week'], 'a day on: all');
});

test('a launch’s Umami campaign slows down with the launch’s age', async () => {
  const registry = await memoryRegistry();
  const t0 = new Date();
  const fresh = await pieceOfAge(registry, 'at://a', 1, t0);
  const old = await pieceOfAge(registry, 'at://b', 40, t0);
  const campaigns: string[] = [];
  const sources: MetricSources = {
    umami: { campaignVisits: async (campaign) => (campaigns.push(campaign), { views: 1, visits: 1, bySource: {}, days: {} }) as never },
  };
  await collectHourly(registry, brand, sources, t0);
  assert.equal(campaigns.length, 2);
  campaigns.length = 0;
  await collectHourly(registry, brand, sources, new Date(t0.getTime() + 10 * MINUTE));
  assert.equal(campaigns.length, 1, 'only the launch of the week');
  assert.ok(fresh && old);
});

test('freshness holds a piece to its cadence by age: a month-old piece read this morning is fresh', async () => {
  const registry = await memoryRegistry();
  const now = new Date();
  const old = await pieceOfAge(registry, 'at://old', 40, now);
  await registry.metrics.recordMetrics(old.launch.id, 'bluesky', { likes: 1 }, new Date(now.getTime() - 6 * 60 * MINUTE), old.posts[0]!.id);
  const [fresh] = (await runChecks(registry, new TelemetryStore(registry.database), { now, cadenceMinutes: 5, cadenceOf: (c) => channelCadence(c)?.minutes })).filter((r) => r.name === 'freshness');
  assert.equal(fresh!.value, 1, 'read 6 hours ago against a daily cadence');
});
