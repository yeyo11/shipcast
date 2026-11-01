import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ago, counted, distinct, periodChip, periodWords } from '../src/components/stats/words.ts';

test('the stats cards say counts, ages and periods in few words', () => {
  assert.equal(counted(1, 'likes'), '1 like');
  assert.equal(counted(4, 'replies'), '4 replies');
  assert.equal(counted(1, 'replies'), '1 reply');
  const now = Date.parse('2026-10-31T12:00:00Z');
  assert.equal(ago('2026-10-31T10:00:00Z', now), '2 h ago');
  assert.equal(ago('2026-10-27T12:00:00Z', now), '4 days ago');
  assert.equal(periodWords('30d', '2026-10-02', '2026-10-31'), 'Last 30 days');
  assert.equal(periodChip('custom', '2026-10-01', '2026-10-30'), '1 Oct – 30 Oct');
});

test('two rows that would read the same are told apart by their day, then by their place', () => {
  assert.deepEqual(distinct(['Claudio · Newsletter', 'Claudio · Newsletter', 'Other'], ['2026-10-20', '2026-10-27', null]), ['Claudio · Newsletter · 20 Oct', 'Claudio · Newsletter · 27 Oct', 'Other']);
  assert.deepEqual(distinct(['A', 'A'], ['2026-10-20', '2026-10-20']), ['A · 20 Oct · 1', 'A · 20 Oct · 2']);
});
