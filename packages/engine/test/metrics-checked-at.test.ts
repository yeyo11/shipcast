import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sql } from 'drizzle-orm';
import { channelCadence } from '@shipcast/schema';
import { runChecks, statsRanking, TelemetryStore } from '../src/index.ts';
import { aPublishedLaunch, memoryRegistry } from '../src/testing/index.ts';

/*
 * The owner's rule for the hourly reads (phase 8 of docs/plans/performance-refactor.md): a value
 * read again unchanged moves `checked_at` on the newest reading, and only a change adds a row. The
 * reads keep their meaning: a launch's sum, its curve, the stats' "read in the period", freshness.
 */

const at = (hhmm: string) => new Date(`2026-11-10T${hhmm}:00.000Z`);
const MOVES = { unchangedMovesCheck: true } as const;

async function rows(registry: Awaited<ReturnType<typeof memoryRegistry>>) {
  return registry.queries.selectRows<{ post_id: number | null; name: string; value: number; taken_at: string; checked_at: string | null }>(
    sql`SELECT post_id, name, value, taken_at, checked_at FROM metrics ORDER BY post_id, name, taken_at`,
  );
}

test('unchanged values move checked_at and add no row; a changed value adds one', async () => {
  const registry = await memoryRegistry();
  const { launch, posts } = await aPublishedLaunch(registry, [{ channel: 'bluesky', externalId: 'at://1' }]);
  const post = posts[0]!;
  assert.deepEqual(await registry.metrics.recordMetrics(launch.id, 'bluesky', { likes: 3, reposts: 1 }, at('10:00'), post.id, MOVES), { inserted: 2, checked: 0 });
  assert.deepEqual(await registry.metrics.recordMetrics(launch.id, 'bluesky', { likes: 3, reposts: 1 }, at('11:00'), post.id, MOVES), { inserted: 0, checked: 2 });
  assert.deepEqual(await registry.metrics.recordMetrics(launch.id, 'bluesky', { likes: 5, reposts: 1 }, at('12:00'), post.id, MOVES), { inserted: 1, checked: 1 });

  assert.deepEqual(
    (await rows(registry)).map((r) => `${r.name}=${r.value} ${r.taken_at.slice(11, 16)}..${r.checked_at?.slice(11, 16) ?? '-'}`),
    ['likes=3 10:00..11:00', 'likes=5 12:00..-', 'reposts=1 10:00..12:00'],
  );
  const latest = await registry.metrics.postMetrics(post.id);
  assert.deepEqual(
    latest.map((m) => [m.name, m.value, m.takenAt.slice(11, 16), m.checkedAt.slice(11, 16)]),
    [
      ['likes', 5, '12:00', '12:00'],
      ['reposts', 1, '10:00', '12:00'],
    ],
  );
});

test('without the rule (the six-hourly reads) every reading is a row, as always', async () => {
  const registry = await memoryRegistry();
  const { launch, posts } = await aPublishedLaunch(registry, [{ channel: 'bluesky', externalId: 'at://1' }]);
  await registry.metrics.recordMetrics(launch.id, 'bluesky', { likes: 3 }, at('10:00'), posts[0]!.id);
  await registry.metrics.recordMetrics(launch.id, 'bluesky', { likes: 3 }, at('16:00'), posts[0]!.id);
  assert.equal((await rows(registry)).length, 2);
  assert.ok((await rows(registry)).every((r) => r.checked_at === null));
});

test("a launch's sum and curve add up pieces whose last change happened at different moments", async () => {
  const registry = await memoryRegistry();
  // Two newsletter issues: one moves at 11:00, the other holds from 10:00
  const { launch, posts } = await aPublishedLaunch(registry, [
    { channel: 'newsletter', kind: 'issue:en', externalId: '1' },
    { channel: 'newsletter', kind: 'issue:es', externalId: '2' },
  ]);
  const [en, es] = posts as [(typeof posts)[0], (typeof posts)[0]];
  for (const [when, enOpens] of [['10:00', 10], ['11:00', 12], ['12:00', 12]] as const) {
    await registry.metrics.recordMetrics(launch.id, 'newsletter', { opens: enOpens }, at(when), en.id, MOVES);
    await registry.metrics.recordMetrics(launch.id, 'newsletter', { opens: 4 }, at(when), es.id, MOVES);
  }
  const latest = await registry.metrics.latestMetrics(launch.id);
  assert.deepEqual(
    latest.map((m) => [m.source, m.name, m.value, m.takenAt.slice(11, 16), m.checkedAt.slice(11, 16)]),
    [['newsletter', 'opens', 16, '11:00', '12:00']],
    'both issues, though only one changed since 10:00',
  );
  const curve = await registry.metrics.metricHistory(launch.id, 'newsletter', 'opens');
  assert.deepEqual(
    curve.map((p) => [p.takenAt.slice(11, 16), p.value]),
    [
      ['10:00', 14],
      ['11:00', 16],
      ['12:00', 16],
    ],
  );
  const pieces = await registry.metrics.postMetricHistory(launch.id);
  assert.deepEqual(
    pieces.map((r) => [r.postId === en.id ? 'en' : 'es', r.value, r.takenAt.slice(11, 16), r.checkedAt.slice(11, 16)]),
    [
      ['en', 10, '10:00', '10:00'],
      ['es', 4, '10:00', '12:00'],
      ['en', 12, '11:00', '12:00'],
    ],
  );
});

test('a piece read again unchanged in a period is still read in it: the ranking keeps it', async () => {
  const registry = await memoryRegistry();
  // One piece per launch: a launch has one live piece per channel and kind
  const first = await aPublishedLaunch(registry, [{ channel: 'bluesky', externalId: 'at://1' }]);
  const second = await aPublishedLaunch(registry, [{ channel: 'bluesky', externalId: 'at://2' }], { ref: 'v1.1.0' });
  const [a, b] = [first.posts[0]!, second.posts[0]!];
  await registry.metrics.recordMetrics(first.launch.id, 'bluesky', { likes: 4 }, new Date('2026-11-09T10:00:00Z'), a.id, MOVES);
  await registry.metrics.recordMetrics(second.launch.id, 'bluesky', { likes: 1 }, new Date('2026-11-09T10:00:00Z'), b.id, MOVES);
  // On the 10th, a moves and b holds: b has no row that day, only its checked_at
  await registry.metrics.recordMetrics(first.launch.id, 'bluesky', { likes: 9 }, at('10:00'), a.id, MOVES);
  await registry.metrics.recordMetrics(second.launch.id, 'bluesky', { likes: 1 }, at('10:00'), b.id, MOVES);
  const ranking = await statsRanking(registry, { by: 'post', from: '2026-11-10', to: '2026-11-10' });
  assert.deepEqual(
    ranking.entries.map((e) => [e.postId, e.metrics.reactions]),
    [
      [a.id, 5],
      [b.id, 0],
    ],
  );
});

test("freshness ages a reading from its last check, against each channel's own cadence", async () => {
  const registry = await memoryRegistry();
  const store = new TelemetryStore(registry.database);
  const { launch, posts } = await aPublishedLaunch(registry, [
    { channel: 'bluesky', externalId: 'at://1' },
    { channel: 'mastodon', externalId: '1' },
  ]);
  const now = at('15:10');
  // Both first read at 09:00; bluesky read again unchanged at 15:00, mastodon not since
  await registry.metrics.recordMetrics(launch.id, 'bluesky', { likes: 1 }, at('09:00'), posts[0]!.id, MOVES);
  await registry.metrics.recordMetrics(launch.id, 'mastodon', { favourites: 1 }, at('09:00'), posts[1]!.id, MOVES);
  await registry.metrics.recordMetrics(launch.id, 'bluesky', { likes: 1 }, at('15:00'), posts[0]!.id, MOVES);

  const [fresh] = (await runChecks(registry, store, { now, cadenceHours: 6, cadenceOf: (c) => channelCadence(c)?.hours })).filter((r) => r.name === 'freshness');
  const channels = (fresh!.detail as { channels: Record<string, { cadenceHours: number; withinCadence: number }> }).channels;
  assert.deepEqual(channels.bluesky && [channels.bluesky.cadenceHours, channels.bluesky.withinCadence], [1, 1]);
  assert.deepEqual(channels.mastodon && [channels.mastodon.cadenceHours, channels.mastodon.withinCadence], [1, 0], 'six hours old against an hourly cadence');
  assert.equal(fresh!.value, 0.5);
  assert.equal((fresh!.detail as { cadenceHours: number }).cadenceHours, 6, 'the shape of the answer is kept');
});

test('a referrer or page out of GitHub’s top ten since the last read is no longer among the latest numbers', async () => {
  const registry = await memoryRegistry();
  const { launch } = await aPublishedLaunch(registry, []);
  await registry.metrics.recordMetrics(launch.id, 'github', { views: 9, 'referrer:a.dev': 4, 'referrer_visitors:a.dev': 2, 'referrer:b.dev': 3, 'path:/x': 5 }, at('09:00'), null, MOVES);
  // The next day's read: b.dev dropped out of the top ten, a.dev unchanged, /x changed
  await registry.metrics.recordMetrics(launch.id, 'github', { views: 12, 'referrer:a.dev': 4, 'referrer_visitors:a.dev': 2, 'path:/x': 6 }, at('10:00'), null, MOVES);
  const latest = Object.fromEntries((await registry.metrics.latestMetrics(launch.id)).map((m) => [m.name, m.value]));
  assert.deepEqual(latest, { views: 12, 'referrer:a.dev': 4, 'referrer_visitors:a.dev': 2, 'path:/x': 6 });
});
