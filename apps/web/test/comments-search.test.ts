import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readCommentsSearch } from '../src/server/comments-search.ts';

test('only what narrows the list is kept', () => {
  assert.deepEqual(readCommentsSearch({}), {});
  assert.deepEqual(readCommentsSearch({ state: 'waiting', channel: 'mastodon', launch: '4', post: 9, q: ' install ', page: '3' }), { state: 'waiting', channel: 'mastodon', launch: 4, post: 9, q: 'install', page: 3 });
});

test('a hand-edited address cannot break the page', () => {
  assert.deepEqual(readCommentsSearch({ state: 'all', channel: 'x;drop', launch: '-1', post: 'abc', q: '   ', page: '0' }), {});
  assert.deepEqual(readCommentsSearch({ page: '1' }), {}, 'the first page is the default');
});

test('a post without its launch is no filter', () => {
  assert.deepEqual(readCommentsSearch({ post: '9' }), {});
});
