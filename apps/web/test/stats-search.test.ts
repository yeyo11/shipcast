import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvalidInput } from '../src/server/input.ts';
import { compactSearch, DEFAULTS, effectiveBucket, parseGrowthInput, parseStatsInput, readStatsSearch, resolvePeriod, withDefaults } from '../src/server/stats-search.ts';

test('the address is read leniently: what is not valid falls back to the default', () => {
  assert.deepEqual(readStatsSearch({ period: 'forever', metric: 'views', groupBy: 'nope', channels: 'bluesky,Bad Channel', accounts: '3,x,-1,4', page: '0', compare: '1' }), {
    metric: 'views',
    compare: true,
    channels: ['bluesky'],
    accounts: [3, 4],
  });
  assert.deepEqual(readStatsSearch({ launches: '7,7,0,abc' }), { launches: [7] });
  assert.deepEqual(compactSearch(withDefaults({ launches: [7, 9] })), { launches: [7, 9] });
  assert.deepEqual(readStatsSearch({ period: 'custom', from: '2026-10-05', to: '2026-10-01' }), {}, 'a backwards range is dropped');
  assert.deepEqual(readStatsSearch({ period: 'custom', from: '2026-02-30', to: '2026-03-01' }), {}, 'a day that does not exist is dropped');
  assert.deepEqual(readStatsSearch({ period: 'custom', from: '2026-10-01', to: '2026-10-05' }), { period: 'custom', from: '2026-10-01', to: '2026-10-05' });
});

test('the default view is a plain address and a custom range keeps its days', () => {
  assert.deepEqual(compactSearch(DEFAULTS), {});
  assert.deepEqual(compactSearch(withDefaults({ period: '7d', from: '2026-10-01' })), { period: '7d' });
  assert.deepEqual(compactSearch(withDefaults({ period: 'custom', from: '2026-10-01', to: '2026-10-05', compare: true })), { period: 'custom', from: '2026-10-01', to: '2026-10-05', compare: true });
});

test('periods resolve to whole days ending today, and long ones are charted in weeks', () => {
  assert.deepEqual(resolvePeriod({ period: '7d' }, '2026-10-25'), { from: '2026-10-19', to: '2026-10-25', days: 7 });
  assert.equal(resolvePeriod({ period: '90d' }, '2026-10-25').days, 90);
  assert.equal(effectiveBucket('day', 90), 'day');
  assert.equal(effectiveBucket('day', 200), 'week');
});

test('the server function refuses what the page would never send', () => {
  assert.deepEqual(parseStatsInput({}), DEFAULTS);
  const bad: unknown[] = [
    null,
    [],
    { period: 'yesterday' },
    { period: 'custom' },
    { period: 'custom', from: '2026-10-05', to: '2026-10-01' },
    { period: 'custom', from: '2020-01-01', to: '2026-10-01' },
    { period: '7d', from: '2026-10-01', to: '2026-10-02' },
    { metric: 'likes' },
    { compare: 'yes' },
    { channels: 'bluesky' },
    { channels: ['Not Valid'] },
    { accounts: [1.5] },
    { launches: ['3'] },
    { launches: Array.from({ length: 51 }, (_, i) => i + 1) },
    { page: 0 },
    { order: 'sideways' },
  ];
  for (const input of bad) assert.throws(() => parseStatsInput(input), InvalidInput, JSON.stringify(input));
  assert.deepEqual(parseStatsInput({ channels: ['bluesky', 'bluesky'], accounts: [2], compare: true, sort: 'views', order: 'asc', page: 3 }).channels, ['bluesky']);
});

test('the growth period is two real days in order', () => {
  assert.deepEqual(parseGrowthInput({ from: '2026-10-01', to: '2026-10-02' }), { from: '2026-10-01', to: '2026-10-02' });
  assert.throws(() => parseGrowthInput({ from: '2026-10-02', to: '2026-10-01' }), InvalidInput);
  assert.throws(() => parseGrowthInput({ from: 'x', to: '2026-10-01' }), InvalidInput);
  assert.throws(() => parseGrowthInput(undefined), InvalidInput);
});
