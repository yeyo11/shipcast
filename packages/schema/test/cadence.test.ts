import assert from 'node:assert/strict';
import { test } from 'node:test';
import { channelAnalyticsCadence, channelCadence, SITE_CADENCES } from '../src/index.ts';

/*
 * How often each source is read, in minutes (docs/publishing.md, "Cadences"): every 5 minutes where
 * the network has no tight quota, every 15 where it has one, slower only where the source itself is
 * daily or lagged, or where 15 minutes would not fit its limit (Facebook).
 */

test('the sources with no tight quota are read every 5 minutes', () => {
  for (const channel of ['bluesky', 'mastodon', 'blog', 'telegram', 'githubDiscussions']) assert.equal(channelCadence(channel)?.minutes, 5, channel);
  assert.equal(SITE_CADENCES.umami.minutes, 5);
  assert.equal(SITE_CADENCES.githubCounts.minutes, 5);
});

test('the quota-bound sources are read every 15 minutes, Facebook every 30', () => {
  for (const channel of ['instagram', 'threads', 'newsletter', 'devto', 'discord', 'hashnode', 'reddit', 'youtube']) assert.equal(channelCadence(channel)?.minutes, 15, channel);
  assert.equal(channelCadence('facebook')?.minutes, 30, 'two calls a post against the Page’s daily limit');
});

test('the daily and lagged sources keep their cadence', () => {
  const DAY = 24 * 60;
  assert.equal(SITE_CADENCES.githubTraffic.minutes, DAY);
  assert.equal(SITE_CADENCES.githubHistory.minutes, DAY);
  assert.equal(SITE_CADENCES.searchAnalytics.minutes, DAY);
  assert.equal(SITE_CADENCES.urlInspection.minutes, DAY);
  assert.equal(SITE_CADENCES.urlInspectionIndexed.minutes, 7 * DAY);
  assert.equal(SITE_CADENCES.bing.minutes, DAY);
  assert.equal(channelAnalyticsCadence('youtube')?.minutes, DAY);
  assert.equal(channelAnalyticsCadence('devto')?.minutes, DAY);
});
