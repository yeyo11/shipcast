import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ago, counted, periodChip, periodWords } from '../src/components/stats/words.ts';

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
