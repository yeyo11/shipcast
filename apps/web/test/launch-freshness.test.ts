import assert from 'node:assert/strict';
import { test } from 'node:test';
import { launchUpdated } from '../src/server/launch-freshness.ts';
import { overdueWords, updatedWords } from '../src/server/launch-summary.ts';

/*
 * A launch's card says once when its numbers were last updated (the newest read among its totals'
 * sources), and marks it only when a source is overdue by the freshness check's own rule: its
 * cadence, slowed by the piece's age, plus the check's grace. A daily source read on schedule is not.
 */

const now = new Date('2026-11-07T12:00:00.000Z');
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000).toISOString();
const daysAgo = (d: number) => minutesAgo(d * 24 * 60);

test('updated is the newest read, and nothing is overdue while every source keeps its cadence', () => {
  const updated = launchUpdated(
    [
      { source: 'bluesky', name: 'likes', value: 3, checkedAt: minutesAgo(4), publishedAt: daysAgo(1) },
      { source: 'devto', name: 'views', value: 9, checkedAt: minutesAgo(12), publishedAt: daysAgo(1) },
      // Daily, read 20 hours ago: on schedule
      { source: 'search', name: 'clicks', value: 2, checkedAt: minutesAgo(20 * 60), publishedAt: daysAgo(1) },
      // A month-old piece is read daily: 10 hours is on schedule
      { source: 'bluesky', name: 'likes', value: 1, checkedAt: minutesAgo(10 * 60), publishedAt: daysAgo(40) },
    ],
    now,
  );
  assert.deepEqual(updated, { readAt: minutesAgo(4), overdue: [] });
});

test('a source past its cadence and the grace is overdue, by how long it has not been read', () => {
  const updated = launchUpdated(
    [
      { source: 'bluesky', name: 'likes', value: 3, checkedAt: minutesAgo(4), publishedAt: daysAgo(1) },
      { source: 'devto', name: 'views', value: 9, checkedAt: daysAgo(2), publishedAt: daysAgo(3) },
      { source: 'devto', name: 'reactions', value: 1, checkedAt: daysAgo(2), publishedAt: daysAgo(3) },
    ],
    now,
  );
  assert.deepEqual(updated?.overdue, [{ source: 'devto', since: daysAgo(2) }]);
  assert.equal(overdueWords(updated!.overdue, now), 'dev.to not read for 2 days');
  assert.equal(updatedWords(updated!.readAt, now), 'updated 4 min ago');
  assert.equal(launchUpdated([], now), undefined);
});
