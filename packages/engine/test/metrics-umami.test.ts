import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CampaignVisits } from '@shipcast/connectors';
import { Brand } from '@shipcast/schema';
import { campaignDays, campaignValues, collectHourly, type MetricSources } from '../src/index.ts';
import { aLaunch, aPublishedLaunch, memoryRegistry } from '../src/testing/index.ts';

/*
 * SHP-4: the blog's visits from each launch's tagged links, read from Umami by the launch's campaign
 * and kept per source, over the launch and per day (metric_days).
 */

const brand = Brand.parse({ id: 'personal', displayName: 'Me', site: 'https://josegarrido.dev', github: 'yeyo11' });
const HOUR = 3_600_000;

const VISITS: CampaignVisits = {
  bySource: { bluesky: { views: 30, visits: 20, visitors: 18 }, newsletter: { views: 7, visits: 5, visitors: 5 } },
  days: {
    bluesky: { '2026-10-25': { views: 10, visitors: 6 }, '2026-10-26': { views: 20, visitors: 12 } },
    newsletter: { '2026-10-26': { views: 7, visitors: 5 } },
  },
};

function fakeUmami(answer: (campaign: string) => CampaignVisits = () => VISITS) {
  const asked: Array<{ campaign: string; since: string; until: string }> = [];
  const umami: NonNullable<MetricSources['umami']> = {
    async campaignVisits(campaign, since, until) {
      asked.push({ campaign, since, until });
      return answer(campaign);
    },
  };
  return { umami, asked };
}

async function twoLaunches() {
  const registry = await memoryRegistry();
  const release = await aPublishedLaunch(registry, [{ channel: 'bluesky', externalId: 'at://did:plc:me/app.bsky.feed.post/1' }], { repo: 'yeyo11/claudio', ref: 'v1.0.0' });
  const article = await aPublishedLaunch(registry, [{ channel: 'blog', kind: 'article:en', externalId: 'a', url: 'https://josegarrido.dev/en/why-local/' }], { repo: 'yeyo11/josegarrido.dev', ref: 'article:why-local' });
  // Not out yet: nothing of it can have been visited
  await aLaunch(registry, { ref: 'v2.0.0', status: 'drafted' });
  return { registry, release: release.launch, article: article.launch };
}

test('characterisation: without an Umami source the hourly reads keep nothing of it', async () => {
  const { registry, release } = await twoLaunches();
  const result = await collectHourly(registry, brand, {}, new Date());
  assert.deepEqual(result.problems, []);
  assert.deepEqual((await registry.metrics.latestMetrics(release.id)).filter((m) => m.source === 'umami'), []);
  assert.deepEqual(await registry.metrics.metricDays(release.id, 'umami'), []);
});

test('a campaign’s visits become readings per source and days per source', () => {
  assert.deepEqual(campaignValues(VISITS), {
    views: 37,
    visits: 25,
    views_bluesky: 30,
    visits_bluesky: 20,
    visitors_bluesky: 18,
    views_newsletter: 7,
    visits_newsletter: 5,
    visitors_newsletter: 5,
  });
  assert.deepEqual(campaignDays(VISITS), {
    '2026-10-25': { views: 10, views_bluesky: 10, visitors_bluesky: 6 },
    '2026-10-26': { views: 27, views_bluesky: 20, visitors_bluesky: 12, views_newsletter: 7, visitors_newsletter: 5 },
  });
  assert.deepEqual(campaignValues({ bySource: {}, days: {} }), { views: 0, visits: 0 });
});

test('every published launch is read by its campaign, from its day, and kept with its days', async () => {
  const { registry, release, article } = await twoLaunches();
  const { umami, asked } = fakeUmami();
  const now = new Date('2026-10-30T12:00:00Z');
  const result = await collectHourly(registry, brand, { umami }, now);
  assert.deepEqual(result.problems, []);
  // The drafted launch is not read
  assert.deepEqual(
    asked.map((a) => a.campaign).sort(),
    ['claudio-v1-0-0', 'why-local'],
  );
  assert.deepEqual(asked.find((a) => a.campaign === 'claudio-v1-0-0'), { campaign: 'claudio-v1-0-0', since: release.createdAt.slice(0, 10), until: '2026-10-30' });
  assert.equal(asked.find((a) => a.campaign === 'why-local')?.since, article.createdAt.slice(0, 10));

  const latest = Object.fromEntries((await registry.metrics.latestMetrics(release.id)).filter((m) => m.source === 'umami').map((m) => [m.name, m.value]));
  assert.deepEqual(latest, campaignValues(VISITS));
  const days = await registry.metrics.metricDays(article.id, 'umami');
  assert.deepEqual(
    days.filter((d) => d.day === '2026-10-26').map((d) => [d.name, d.value]),
    [
      ['views', 27],
      ['views_bluesky', 20],
      ['views_newsletter', 7],
      ['visitors_bluesky', 12],
      ['visitors_newsletter', 5],
    ],
  );
  assert.ok(days.every((d) => d.postId === null), 'the site’s visits are the launch’s, not a piece’s');
});

test('Umami is read at most hourly, and a launch it fails for is a problem that stops nothing else', async () => {
  const { registry, release, article } = await twoLaunches();
  const { umami, asked } = fakeUmami((campaign) => {
    if (campaign === 'why-local') throw new Error('Umami: visits by source: 500');
    return VISITS;
  });
  const t0 = new Date('2026-10-30T12:00:00Z');
  const first = await collectHourly(registry, brand, { umami }, t0);
  assert.equal(first.problems.length, 1);
  assert.match(first.problems[0]!, /article:why-local Umami: Umami: visits by source: 500/);
  assert.equal((await registry.metrics.latestMetrics(release.id)).filter((m) => m.source === 'umami').length, 8);
  assert.equal((await registry.metrics.latestMetrics(article.id)).filter((m) => m.source === 'umami').length, 0);

  await collectHourly(registry, brand, { umami }, new Date(t0.getTime() + 60_000));
  assert.deepEqual(
    asked.slice(2).map((a) => a.campaign),
    ['why-local'],
    'a minute later only the launch never read is asked again',
  );
  await collectHourly(registry, brand, { umami }, new Date(t0.getTime() + HOUR));
  assert.equal(asked.slice(3).length, 2, 'an hour later both are due');
});
