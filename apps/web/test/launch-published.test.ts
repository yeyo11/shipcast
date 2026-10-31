import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ago, dayOnly, dayTime, elapsed } from '../src/components/launch/dates.ts';
import { channelRows, chartPoints, listWords, metricCaption, pillClass, unpublishGroups, withScheduled } from '../src/components/launch/published.ts';
import { channelEntries, type PieceRow } from '../src/server/pieces.ts';

const TZ = 'Europe/Madrid';

function row(over: Partial<PieceRow> & Pick<PieceRow, 'id' | 'channel'>): PieceRow {
  return {
    kind: 'post',
    piece: '',
    account: null,
    status: 'live',
    url: `https://example.com/${over.id}`,
    publishedAt: '2026-10-20T10:00:00.000Z',
    scheduledAt: null,
    updatedAt: '2026-10-20T10:00:00.000Z',
    metric: null,
    numbers: [],
    edit: { allowed: true, reason: '', fields: ['text'] },
    remove: { allowed: true, reason: '', verb: 'Delete' },
    ...over,
  };
}

test('times read on the owner’s clock, and how long ago in a phone’s words', () => {
  assert.equal(dayTime('2026-10-20T10:00:00.000Z', TZ), '20 Oct, 12:00');
  assert.equal(dayOnly('2026-10-20T23:30:00.000Z', TZ), '21 Oct');
  const now = new Date('2026-10-31T12:00:00.000Z');
  assert.equal(ago('2026-10-31T11:59:40.000Z', now, TZ), 'just now');
  assert.equal(ago('2026-10-31T11:48:00.000Z', now, TZ), '12 min ago');
  assert.equal(ago('2026-10-31T09:00:00.000Z', now, TZ), '3 h ago');
  assert.equal(ago('2026-10-30T09:00:00.000Z', now, TZ), 'yesterday');
  assert.equal(ago('2026-10-28T09:00:00.000Z', now, TZ), '3 days ago');
  assert.equal(ago('2026-10-01T09:00:00.000Z', now, TZ), 'on 1 Oct');
  assert.equal(elapsed(52_000), '52 s');
  assert.equal(elapsed(112_000), '1 min 52 s');
  assert.equal(elapsed(3_840_000), '1 h 4 min');
});

test('the state pill takes its shape from the tone, and drafting always turns', () => {
  assert.equal(pillClass('published', 'published'), 'k-p-pub');
  assert.equal(pillClass('waiting', 'drafted'), 'k-p-wait');
  assert.equal(pillClass('failed', 'failed'), 'k-p-fail');
  assert.equal(pillClass('draft', 'generating'), 'k-p-run');
  assert.equal(pillClass('quiet', 'skipped'), 'k-p-quiet');
  assert.equal(metricCaption('uniqueVisitors'), 'unique visitors');
});

test('a channel row says how it went: out with its number, failed, or waiting for its time', () => {
  const rows = [
    row({ id: 4, channel: 'blog', kind: 'article:en', piece: 'EN' }),
    row({ id: 5, channel: 'bluesky', metric: { name: 'likes', value: 48, series: [48] }, edit: { allowed: false, reason: 'no edit', fields: [] } }),
  ];
  const scheduling = withScheduled([], [{ id: 8, channel: 'telegram', status: 'scheduled', publishedAt: '2026-10-31T01:00:00.000Z', scheduledAt: '2026-10-31T09:00:00.000Z' }]);
  const entries = channelEntries({ rows, failures: [{ channel: 'linkedin', message: 'the token expired' }], scheduling });
  const list = channelRows(entries, { blog: { totals: { views: 775 }, daily: [] } }, TZ);
  assert.deepEqual(
    list.map((r) => [r.channel, r.kind, r.line, r.figure]),
    [
      ['blog', 'out', 'Published 20 Oct, 12:00', { value: 775, caption: 'views' }],
      ['bluesky', 'out', 'Published 20 Oct, 12:00', { value: 48, caption: 'likes' }],
      ['linkedin', 'failed', 'Failed: the token expired', null],
      ['telegram', 'scheduled', 'Scheduled Sat 31 Oct, 10:00', null],
    ],
  );
  assert.equal(list[1]!.editable.length, 0, 'a network with no edit has nothing for Edit selected');
  assert.equal(list[3]!.scheduled?.id, 8, 'Move moves the piece waiting for its time');
});

test('Unpublish offers what each network lets go, the article’s languages together', () => {
  const groups = unpublishGroups([
    row({ id: 1, channel: 'blog', kind: 'article:en', piece: 'EN' }),
    row({ id: 2, channel: 'blog', kind: 'article:es', piece: 'ES' }),
    row({ id: 3, channel: 'devto', remove: { allowed: true, reason: '', verb: 'Unpublish' } }),
    row({ id: 4, channel: 'instagram', remove: { allowed: false, reason: 'no delete', verb: 'Delete' } }),
    row({ id: 5, channel: 'mastodon' }),
  ]);
  assert.deepEqual(
    groups.map((g) => [g.channel, g.pieces.length, g.note]),
    [
      ['blog', 2, 'The article, both languages'],
      ['devto', 1, 'Unpublished: the network keeps a private copy'],
      ['mastodon', 1, null],
    ],
  );
  assert.equal(listWords(['the article', 'Bluesky', 'Mastodon', 'dev.to']), 'the article, Bluesky, Mastodon and dev.to');
  assert.equal(listWords(['Bluesky']), 'Bluesky');
});

test('the views chart peaks at its busiest day, the baseline at the bottom', () => {
  const { points, peak } = chartPoints(
    [
      { day: '2026-10-20', views: 240 },
      { day: '2026-10-21', views: 252 },
      { day: '2026-10-22', views: 0 },
    ],
    358,
  );
  assert.deepEqual(points, [
    [0, 21.9],
    [179, 18],
    [358, 100],
  ]);
  assert.deepEqual(peak, { x: 179, y: 18, views: 252, day: '2026-10-21' });
  assert.deepEqual(chartPoints([], 358), { points: [], peak: null });
});
