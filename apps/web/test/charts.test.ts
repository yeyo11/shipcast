import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  alignToBuckets,
  shortDay,
  placeMarks,
  niceTop,
  brushRange,
  compact,
  deltaLabel,
  moveIndex,
  nearestIndex,
  niceCeiling,
  overlayComparison,
  seriesCsv,
  sliceRange,
  stack,
  tickEvery,
  valueCeiling,
  type ChartSeries,
} from '../src/components/charts/data.ts';
import { assignColours, contrast, SLOTS, SURFACES } from '../src/components/charts/palette.ts';

const s = (key: string, values: Array<number | null>, comparison?: Array<number | null>): ChartSeries => ({ key, label: key, colour: 'red', values, ...(comparison && { comparison }) });

test('series are aligned to the buckets by day, never by position', () => {
  assert.deepEqual(alignToBuckets(['a', 'b', 'c'], [{ bucket: 'c', increase: 3 }, { bucket: 'a', increase: 1 }]), [1, 0, 3]);
});

test('a comparison with fewer buckets breaks the line instead of dropping to zero', () => {
  assert.deepEqual(overlayComparison(4, [5, 6]), [5, 6, null, null]);
});

test('stacks accumulate in order and the axis ceiling lands on a readable step', () => {
  const a = s('a', [1, 2]);
  const b = s('b', [3, null]);
  assert.deepEqual(stack([a, b], 2), [{ key: 'a', y0: [0, 0], y1: [1, 2] }, { key: 'b', y0: [1, 2], y1: [4, 2] }]);
  assert.equal(valueCeiling([a, b], 'area', 2), 5);
  assert.equal(valueCeiling([a, b], 'line', 2), 5, 'a line is as high as its tallest series');
  assert.equal(valueCeiling([s('c', [7]), s('d', [1], [41])], 'line', 1), 50, 'the comparison counts');
  assert.equal(valueCeiling([], 'line', 0), 1);
  assert.equal(niceCeiling(0), 1);
  assert.equal(niceCeiling(2.1), 2.5);
});

test('the keyboard moves through the points and starts at the newest', () => {
  assert.equal(moveIndex('ArrowLeft', null, 10), 9);
  assert.equal(moveIndex('Home', null, 10), 0);
  assert.equal(moveIndex('ArrowRight', 9, 10), 9, 'clamped at the end');
  assert.equal(moveIndex('PageUp', 3, 10), 0);
  assert.equal(moveIndex('PageDown', 3, 10), 9);
  assert.equal(moveIndex('Tab', 3, 10), null, 'a key that is not a move is left to the browser');
  assert.equal(moveIndex('ArrowLeft', null, 0), null);
});

test('the pointer picks the nearest bucket and a brush needs two buckets to zoom', () => {
  assert.equal(nearestIndex(55, 10, 20, 5), 2);
  assert.equal(nearestIndex(-100, 10, 20, 5), 0);
  assert.equal(nearestIndex(1000, 10, 20, 5), 4);
  assert.deepEqual(brushRange(4, 1, 10), [1, 4]);
  assert.equal(brushRange(3, 3, 10), null);
  assert.deepEqual(sliceRange([s('a', [1, 2, 3, 4], [4, 3, 2, 1])], [1, 2]), [s('a', [2, 3], [3, 2])]);
  assert.equal(sliceRange([s('a', [1])], null)[0]?.values.length, 1);
});

test('numbers are written short on axes and deltas keep their sign and meaning', () => {
  assert.deepEqual([950, 1200, 34_000, 1_500_000].map(compact), ['950', '1.2k', '34k', '1.5M']);
  assert.deepEqual(deltaLabel(112, 100), { text: '+12%', direction: 'up' });
  assert.deepEqual(deltaLabel(97, 100), { text: '−3%', direction: 'down' });
  assert.deepEqual(deltaLabel(5, 0), { text: 'new', direction: 'up' });
  assert.deepEqual(deltaLabel(0, 0), { text: '—', direction: 'flat' });
  assert.equal(tickEvery(30, 320), 6);
  assert.equal(tickEvery(3, 1000), 1);
});

test('the CSV has a row per bucket, escapes cells and puts the comparison last', () => {
  const csv = seriesCsv(['2026-10-01', '2026-10-02'], [{ ...s('a', [1, null], [2, 3]), label: 'A, "x"' }]);
  assert.equal(csv, ['bucket,"A, ""x""","A, ""x"" (previous period)"', '2026-10-01,1,2', '2026-10-02,,3', ''].join('\n'));
});

test('every palette colour passes 3:1 on both surfaces of its theme', () => {
  for (const slot of SLOTS) {
    for (const surface of SURFACES.night) assert.ok(contrast(slot.night, surface) >= 3, `${slot.name} night on ${surface}`);
    for (const surface of SURFACES.day) assert.ok(contrast(slot.day, surface) >= 3, `${slot.name} day on ${surface}`);
  }
});

test('a series keeps its colour whatever else is filtered, and nobody shares one', () => {
  const all = assignColours([{ key: 'bluesky', channel: 'bluesky' }, { key: 'mastodon', channel: 'mastodon' }, { key: 'other' }]);
  const some = assignColours([{ key: 'mastodon', channel: 'mastodon' }]);
  assert.equal(all.get('mastodon'), some.get('mastodon'));
  assert.notEqual(all.get('bluesky'), all.get('mastodon'));
  assert.equal(all.get('other'), 'var(--sc-muted)');
  const accounts = assignColours([1, 2, 3].map((id) => ({ key: String(id), channel: 'bluesky', id })));
  assert.equal(new Set(accounts.values()).size, 3, 'three accounts of one network take three colours');
});

test('the redesign writes a day first: 1 Oct, with the year when asked', () => {
  assert.equal(shortDay('2026-10-01'), '1 Oct');
  assert.equal(shortDay('2026-12-25', true), '25 Dec 2026');
});

test('mark labels sit by their guides, flip near the right edge, are cut to fit and never overlap', () => {
  const [a] = placeMarks([{ index: 0, x: 10, label: 'claudio v1.5.0 out' }], 300, 6);
  assert.deepEqual(a, { index: 0, x: 10, anchor: 'start', text: 'claudio v1.5.0 out' });
  const [b] = placeMarks([{ index: 29, x: 290, label: 'claudio v1.5.0 out' }], 300, 6);
  assert.equal(b?.anchor, 'end', 'near the right edge it reads left of its guide');
  const [c] = placeMarks([{ index: 5, x: 150, label: 'Why I moved my notes into the repo, and what it changed out' }], 300, 6);
  assert.ok((c?.text.length ?? 0) * 6 <= 150 && c?.text.endsWith('…'), 'a long name is cut to the room on its side');
  const crowded = placeMarks(
    [
      { index: 1, x: 20, label: 'one out' },
      { index: 2, x: 30, label: 'two out' },
      { index: 3, x: 40, label: 'three out' },
    ],
    300,
    6,
  );
  assert.deepEqual(crowded.map((m) => m.text), ['one out +2'], 'the ones that would touch it are counted, not drawn');
});

test('the value scale fits the data with a little room, on a round number', () => {
  assert.equal(niceTop(3), 5);
  assert.equal(niceTop(92), 100);
  assert.equal(niceTop(0), 1);
});
