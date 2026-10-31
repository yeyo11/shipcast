import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ago, count, words } from '../src/components/write/format.ts';

test('ago says how long ago in the boards’ short words', () => {
  const now = Date.parse('2026-10-31T12:00:00Z');
  assert.equal(ago('2026-10-31T11:59:40Z', now), 'just now');
  assert.equal(ago('2026-10-31T11:59:00Z', now), '1 min ago');
  assert.equal(ago('2026-10-31T10:00:00Z', now), '2 h ago');
  assert.equal(ago('2026-10-30T11:00:00Z', now), '1 day ago');
  assert.equal(ago('2026-10-22T12:00:00Z', now), '9 days ago');
  assert.equal(ago('2026-07-31T12:00:00Z', now), '3 months ago');
  assert.equal(ago('2024-10-01T12:00:00Z', now), '2 years ago');
  // A clock a little ahead never says "in"
  assert.equal(ago('2026-10-31T12:00:30Z', now), 'just now');
  assert.equal(ago('not a date', now), '');
});

test('words counts what lies between spaces', () => {
  assert.equal(words(''), 0);
  assert.equal(words('  \n '), 0);
  assert.equal(words('Now every decision is a Markdown file under `docs/`.\n\nNext.'), 10);
  assert.equal(count(1, 'word'), '1 word');
  assert.equal(count(1412, 'word'), '1,412 words');
});
