import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHANNEL_METRIC_FAMILIES, EXPIRING_PIECES, lastMetricsRead, readsMetrics } from '../src/index.ts';

const published = '2026-10-29T10:00:00.000Z';
const after = (hours: number) => ({ publishedAt: published, now: new Date(Date.parse(published) + hours * 3_600_000) });

test('a post, an issue and a main piece have numbers whatever their age; a comment never', () => {
  assert.equal(readsMetrics('instagram', 'post'), true);
  assert.equal(readsMetrics('instagram', 'post', after(24 * 400)), true);
  assert.equal(readsMetrics('newsletter', 'issue:en'), true);
  assert.equal(readsMetrics('instagram', 'comment', after(1)), false);
  assert.equal(readsMetrics('blog', 'article:en', after(1)), false);
});

test('an Instagram story has numbers while Meta keeps them, 24 hours, and its last read is at 23 h 30 min, half an hour before they go', () => {
  assert.deepEqual(EXPIRING_PIECES, [{ channel: 'instagram', kind: 'story', hours: 24, lastReadHours: 23.5 }]);
  assert.equal(readsMetrics('instagram', 'story'), false, 'without its age a story is never read');
  assert.equal(readsMetrics('instagram', 'story', after(1)), true);
  assert.equal(readsMetrics('instagram', 'story', after(23.9)), true);
  assert.equal(readsMetrics('instagram', 'story', after(24)), false);
  assert.equal(lastMetricsRead('instagram', 'story', published)?.toISOString(), '2026-10-30T09:30:00.000Z');
  assert.equal(lastMetricsRead('instagram', 'post', published), undefined);
});

test('Instagram’s reach is no family’s, and a repost is a share; Threads’ link clicks are clicks', () => {
  assert.equal(CHANNEL_METRIC_FAMILIES.instagram?.impressions, undefined, 'reach is unique accounts, not impressions');
  assert.deepEqual(CHANNEL_METRIC_FAMILIES.instagram?.shares, ['shares', 'reposts']);
  assert.deepEqual(CHANNEL_METRIC_FAMILIES.instagram?.clicks, ['bio_link_clicks']);
  assert.deepEqual(CHANNEL_METRIC_FAMILIES.threads?.clicks, ['clicks']);
});

test('a Discord message is read for 30 days, then no more: its reactions have settled', () => {
  const now = new Date('2026-11-30T12:00:00Z');
  const age = (days: number) => ({ publishedAt: new Date(now.getTime() - days * 86_400_000).toISOString(), now });
  assert.equal(readsMetrics('discord', 'post', age(29)), true);
  assert.equal(readsMetrics('discord', 'post', age(31)), false);
  assert.equal(readsMetrics('bluesky', 'post', age(400)), true, 'other networks keep being read, tapered');
});
