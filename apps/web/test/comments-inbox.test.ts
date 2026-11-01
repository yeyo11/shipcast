import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ago, inboxTab, listFilter, nextCheckIn, position, readInboxSearch } from '../src/server/comments-inbox.ts';

test('the inbox opens on what waits, and All is a tab of its own', () => {
  assert.deepEqual(readInboxSearch({}), {});
  assert.equal(inboxTab(readInboxSearch({})), 'waiting');
  assert.deepEqual(readInboxSearch({ state: 'waiting' }), {}, 'Waiting is the default, so it is left out');
  assert.deepEqual(readInboxSearch({ state: 'all' }), { state: 'all' });
  assert.deepEqual(readInboxSearch({ state: 'replied', reply: '7', channel: 'bluesky' }), { state: 'replied', reply: 7, channel: 'bluesky' });
});

test('a hand-edited address cannot break the inbox', () => {
  assert.deepEqual(readInboxSearch({ state: 'nope', reply: '-3', page: '0' }), {});
  assert.deepEqual(readInboxSearch({ reply: 'abc' }), {});
});

test('the list is asked for by state, every state for All, without the open comment', () => {
  assert.deepEqual(listFilter({}), { state: 'waiting' });
  assert.deepEqual(listFilter({ state: 'all', reply: 3, q: 'install' }), { q: 'install' });
  assert.deepEqual(listFilter({ state: 'ignored', page: 2 }), { state: 'ignored', page: 2 });
});

test('times are written short, as beside a name', () => {
  const now = new Date('2026-10-31T12:00:00Z');
  assert.equal(ago('2026-10-31T11:59:40Z', now), 'now');
  assert.equal(ago('2026-10-31T11:36:00Z', now), '24 min');
  assert.equal(ago('2026-10-31T10:00:00Z', now), '2 h');
  assert.equal(ago('2026-10-28T12:00:00Z', now), '3 d');
  assert.equal(ago('2026-10-14T09:20:00Z', now), '14 Oct');
  assert.equal(ago('2025-10-14T09:20:00Z', now), '14 Oct 2025');
});

test('the next read is on the next hour or half hour, in UTC', () => {
  assert.equal(nextCheckIn(new Date('2026-10-31T12:06:00Z')), 24);
  assert.equal(nextCheckIn(new Date('2026-10-31T12:06:30Z')), 24, 'a part of a minute counts as one');
  assert.equal(nextCheckIn(new Date('2026-10-31T12:30:00Z')), 30);
  assert.equal(nextCheckIn(new Date('2026-10-31T12:59:59Z')), 1);
});

test('an open comment says where it stands in its list and which comes next', () => {
  const list = [{ id: 4 }, { id: 9 }];
  assert.deepEqual(position(list, 4, 2, 'waiting'), { label: '1 of 2 waiting', next: { id: 9 } });
  assert.deepEqual(position(list, 9, 8, 'all'), { label: '2 of 8', next: undefined });
  assert.deepEqual(position(list, 5, 2, 'waiting'), { label: null, next: undefined }, 'a comment that left the list, sent from here');
});
