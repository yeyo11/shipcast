import assert from 'node:assert/strict';
import { test } from 'node:test';
import { METRIC_FAMILIES } from '@shipcast/engine';
import { cardChannels, channelTotals, splitSeries, dailyViews, postAccountNames, dayOffset, foldMarks, latestByPiece, launchDateLabel, launchTotals, markOf, shortNumber, type Mark } from '../src/server/launch-summary.ts';

test('a launch totals its counters through the stats families, with GitHub stars apart from reactions', () => {
  const totals = launchTotals(
    [
      { source: 'blog', name: 'views', value: 40 },
      { source: 'devto', name: 'views', value: 18 },
      { source: 'devto', name: 'reactions', value: 2 },
      { source: 'devto', name: 'comments', value: 1 },
      { source: 'bluesky', name: 'likes', value: 5 },
      { source: 'bluesky', name: 'replies', value: 2 },
      { source: 'newsletter', name: 'opens', value: 10 },
      { source: 'newsletter', name: 'clicks', value: 3 },
      { source: 'search', name: 'clicks', value: 4 },
      { source: 'search', name: 'impressions', value: 900 },
      { source: 'github', name: 'stars', value: 7 },
      { source: 'github', name: 'forks', value: 1 },
      { source: 'unknown', name: 'views', value: 1000 },
    ],
    METRIC_FAMILIES,
  );
  assert.deepEqual(totals, { views: 68, reactions: 7, comments: 3, clicks: 7, stars: 7 });
});

test('each piece counts with its latest reading, whatever order the history comes in', () => {
  const latest = latestByPiece([
    { postId: 1, name: 'likes', value: 5, takenAt: '2026-10-26T06:00:00.000Z' },
    { postId: 1, name: 'likes', value: 3, takenAt: '2026-10-25T06:00:00.000Z' },
    { postId: 2, name: 'likes', value: 1, takenAt: '2026-10-25T06:00:00.000Z' },
    { postId: 1, name: 'reposts', value: 2, takenAt: '2026-10-25T12:00:00.000Z' },
  ]);
  assert.deepEqual(
    latest.map((r) => [r.postId, r.name, r.value]),
    [
      [1, 'likes', 5],
      [2, 'likes', 1],
      [1, 'reposts', 2],
    ],
  );
});

test('views per day start on the launch day and keep the latest days only', () => {
  const points = ['2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27'].map((bucket, i) => ({ bucket, increase: i }));
  assert.deepEqual(dailyViews(points, '2026-10-25T04:06:00.000Z'), [
    { day: '2026-10-25', views: 2 },
    { day: '2026-10-26', views: 3 },
    { day: '2026-10-27', views: 4 },
  ]);
  assert.deepEqual(
    dailyViews(points, '2026-10-20T00:00:00.000Z', 2).map((d) => d.day),
    ['2026-10-26', '2026-10-27'],
  );
  assert.equal(dayOffset('2026-10-27', '2026-10-25T23:59:00.000Z'), 2);
});

test('a channel mark: a failure first, then a time to come, then anything out, else not launched', () => {
  assert.equal(markOf(['live', 'scheduled'], true), 'failed');
  assert.equal(markOf(['live', 'failed'], false), 'failed');
  assert.equal(markOf(['live', 'scheduled'], false), 'scheduled');
  assert.equal(markOf(['edited', 'deleted'], false), 'published');
  assert.equal(markOf(['deleted'], false), 'off');
  assert.equal(markOf([], false), 'off');
});

test('marks stay on one row: problems first, what does not fit folds behind "+n"', () => {
  const m = (channel: string, mark: Mark) => ({ channel, mark });
  const items = [m('blog', 'published'), m('devto', 'published'), m('threads', 'failed'), m('bluesky', 'published'), m('linkedin', 'scheduled'), m('reddit', 'off'), m('mastodon', 'published'), m('instagram', 'published')];
  const { shown, folded } = foldMarks(items, 6);
  assert.deepEqual(
    shown.map((x) => x.channel),
    ['threads', 'linkedin', 'reddit', 'blog', 'devto'],
  );
  assert.deepEqual(
    folded.map((x) => x.channel),
    ['bluesky', 'mastodon', 'instagram'],
  );
  assert.deepEqual(foldMarks(items, 8).folded, [], 'all of them fit, nothing folds');
  assert.deepEqual(
    foldMarks(items, 1).shown.map((x) => x.channel),
    [],
    'room for one: only the +n',
  );
});

test('a launch date reads in the owner zone; big numbers stay short', () => {
  assert.equal(launchDateLabel('2026-10-24T03:06:00.000Z', 'Europe/Madrid'), '24 Oct 2026, 05:06');
  assert.equal(launchDateLabel('2026-10-25T03:06:00.000Z', 'Europe/Madrid'), '25 Oct 2026, 04:06', 'summer time ended that night');
  assert.equal(shortNumber(9876), '9,876');
  assert.equal(shortNumber(12_345), '12.3k');
  assert.equal(shortNumber(2_500_000), '2.5M');
});

test('a card lists each channel once with its posts, told apart by account, language or kind', () => {
  const p = (id: number, channel: string, kind: string, status = 'live', url: string | null = `https://${channel}.example/${id}`) => ({ id, channel, kind, url, status, scheduledAt: status === 'scheduled' ? '2026-10-28T08:30:00.000Z' : null });
  const postAccounts = postAccountNames(
    [
      { id: 1, accountId: null },
      { id: 4, accountId: 7 },
      { id: 5, accountId: 8 },
      { id: 6, accountId: 7 },
    ],
    new Map([
      [7, '@josegarridodev'],
      [8, '@other'],
    ]),
  );
  const channels = cardChannels({
    posts: [p(1, 'blog', 'article:en'), p(2, 'blog', 'article:es'), p(3, 'linkedin', 'post', 'scheduled', null), p(4, 'instagram', 'post'), p(5, 'instagram', 'post'), p(6, 'instagram', 'story', 'live', null)],
    failures: [{ channel: 'threads' }],
    postAccounts,
  });
  assert.deepEqual(
    channels.map((c) => [c.channel, c.mark, c.accounts.length, c.posts.map((x) => x.label)]),
    [
      ['blog', 'published', 0, ['EN', 'ES']],
      ['linkedin', 'scheduled', 0, ['Post']],
      ['instagram', 'published', 2, ['@josegarridodev', '@other', '@josegarridodev · Story']],
      ['threads', 'failed', 0, []],
    ],
  );
});

test('a channel totals only what its network counts, so the card shows a dash for the rest', () => {
  const per = channelTotals(
    [
      { source: 'blog', name: 'views', value: 40 },
      { source: 'bluesky', name: 'likes', value: 5 },
      { source: 'bluesky', name: 'likes', value: 2 },
      { source: 'newsletter', name: 'clicks', value: 3 },
      { source: 'search', name: 'clicks', value: 9 },
      { source: 'github', name: 'stars', value: 7 },
    ],
    METRIC_FAMILIES,
  );
  assert.deepEqual(per, { blog: { views: 40 }, bluesky: { reactions: 7, comments: 0 }, newsletter: { views: 0, clicks: 3 } });
});

test('a launch:channel series splits into each launch summed and each of its channels', () => {
  const pts = (a: number, b: number) => [
    { bucket: '2026-10-25', increase: a },
    { bucket: '2026-10-26', increase: b },
  ];
  const { launches, channels } = splitSeries([
    { key: '3:blog', points: pts(10, 4) },
    { key: '3:devto', points: pts(2, 1) },
    { key: '4:blog', points: pts(0, 7) },
    { key: 'other', points: pts(99, 99) },
  ]);
  assert.deepEqual(launches.get(3), pts(12, 5));
  assert.deepEqual(launches.get(4), pts(0, 7));
  assert.deepEqual([...(channels.get(3)?.keys() ?? [])], ['blog', 'devto']);
  assert.equal(launches.size, 2);
});
