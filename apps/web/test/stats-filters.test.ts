import assert from 'node:assert/strict';
import { test } from 'node:test';
import { grouped, summarize, type FilterOption } from '../src/components/stats/filter-options.ts';

const accounts: FilterOption[] = [
  { value: '1', label: '@me@mastodon.social', hint: 'Mastodon', group: 'Mastodon' },
  { value: '2', label: '@me.bsky.social', hint: 'Bluesky', group: 'Bluesky' },
  { value: '3', label: '@work@fosstodon.org', hint: 'Mastodon', group: 'Mastodon' },
];

test('a pill says the one choice by name and several by how many, so it keeps its size', () => {
  assert.equal(summarize([], accounts, 'accounts'), null);
  assert.equal(summarize(['2'], accounts, 'accounts'), '@me.bsky.social');
  assert.equal(summarize(['1', '2', '3'], accounts, 'accounts'), '3 accounts');
});

test('the list keeps its groups in order, and a search matches a label or a network', () => {
  assert.deepEqual(
    grouped(accounts, '').map((g) => [g.group, g.options.map((o) => o.value)]),
    [
      ['Mastodon', ['1', '3']],
      ['Bluesky', ['2']],
    ],
  );
  assert.deepEqual(grouped(accounts, 'fosstodon').map((g) => g.options.map((o) => o.value)), [['3']]);
  assert.deepEqual(grouped(accounts, 'BLUESKY').map((g) => g.group), ['Bluesky']);
  assert.deepEqual(grouped(accounts, 'nothing'), []);
});
