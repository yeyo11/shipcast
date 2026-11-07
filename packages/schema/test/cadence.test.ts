import assert from 'node:assert/strict';
import { test } from 'node:test';
import { channelAnalyticsCadence, channelCadence, SITE_CADENCES, taperedMinutes } from '../src/index.ts';

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

test('a piece is read at its cadence for a week, hourly to a month, then daily', () => {
  const now = new Date('2026-11-30T12:00:00Z');
  const ago = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
  assert.equal(taperedMinutes(15, ago(1), now), 15);
  assert.equal(taperedMinutes(5, ago(6.9), now), 5);
  assert.equal(taperedMinutes(15, ago(7), now), 60);
  assert.equal(taperedMinutes(5, ago(29), now), 60);
  assert.equal(taperedMinutes(30, ago(30), now), 24 * 60);
  assert.equal(taperedMinutes(7 * 24 * 60, ago(60), now), 7 * 24 * 60, 'never faster than its own cadence');
});
