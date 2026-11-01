import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AttentionItem } from '../src/server/attention.ts';
import {
  ACTIONS,
  connectGroups,
  emptyGroups,
  filterEntries,
  GO_TO,
  isRepoName,
  matchEntry,
  needsEntries,
  sequenceTarget,
  tryGroup,
  typedGroups,
  type PaletteLaunch,
  type PaletteNetwork,
  type PaletteSources,
} from '../src/components/ui/palette.ts';

const now = new Date('2026-11-01T12:00:00Z');

const launch = (id: number, repo: string, ref: string, extra: Partial<PaletteLaunch> = {}): PaletteLaunch => ({
  id,
  repo,
  ref,
  title: null,
  status: 'published',
  state: { label: 'Published', tone: 'published' },
  createdAt: `2026-10-${String(10 + id).padStart(2, '0')}T10:00:00Z`,
  ...extra,
});

const launches: PaletteLaunch[] = [
  launch(1, 'yeyo11/claudio', 'v1.5.0'),
  launch(2, 'yeyo11/sluice', 'v1.4.0'),
  launch(3, 'yeyo11/blog', 'article:sluice-one-queue', { title: 'Sluice: one queue for the builds, tests and heavy commands of all your agents' }),
  launch(4, 'yeyo11/blog', 'article:what-i-learnt', { title: 'What I learnt shipping slowly: three launches in a week' }),
  launch(5, 'yeyo11/pando', 'v1.0.0', { status: 'drafted', state: { label: 'Waiting for you', tone: 'waiting' }, ready: { count: 4 } }),
  launch(6, 'yeyo11/sluice', 'v2.0.0', { status: 'failed', state: { label: 'Failed', tone: 'failed' } }),
  launch(7, 'yeyo11/shipcast', 'v0.9.0', { status: 'generating', state: { label: 'Drafting', tone: 'draft' }, createdAt: '2026-11-01T11:58:00Z' }),
];

const networks: PaletteNetwork[] = [
  { id: 'linkedin', name: 'LinkedIn', accounts: [{ id: 9, label: 'José Antonio Garrido', status: 'failed', problem: 'The token expired' }] },
  { id: 'bluesky', name: 'Bluesky', accounts: [{ id: 1, label: 'Bluesky', identity: '@josegarrido.dev', status: 'ok', problem: null }] },
  { id: 'threads', name: 'Threads', accounts: [] },
  { id: 'reddit', name: 'Reddit', accounts: [] },
];

const attention: AttentionItem[] = [
  { key: 'launch:5:waiting:x', kind: 'approve', text: 'Pando v1.0.0 waits for your approval', action: 'Review the drafts', target: { to: '/launches/$id', params: { id: '5' } }, subject: 'Pando v1.0.0' },
  { key: 'launch:6:failed:y', kind: 'retry', text: 'Sluice v2.0.0 failed: claudio was overloaded', action: 'Retry', target: { to: '/launches/$id', params: { id: '6' } }, subject: 'Sluice v2.0.0' },
  { key: 'comments:waiting:3', kind: 'reply', text: '2 comments wait for a reply', action: 'Answer', target: { to: '/comments', search: { state: 'waiting' } }, count: 2, subject: '2 comments' },
  { key: 'account:9:reconnect:z', kind: 'reconnect', text: 'José Antonio Garrido (LinkedIn) needs reconnecting', action: 'Reconnect', target: { to: '/channels', search: { focus: '9' } }, subject: 'José Antonio Garrido', channel: 'linkedin' },
  { key: 'launch:1:scheduled:1:1', kind: 'scheduled', text: '1 post of Claudio v1.5.0 goes out in 3 h', action: 'See it', target: { to: '/launches/$id', params: { id: '1' } } },
];

const sources = (): PaletteSources => ({ needs: needsEntries(attention, launches, networks, now), launches, networks, timezone: 'UTC', now });

test('the bell’s lines read as verbs, with their meta and pill; a scheduled post is not a thing to do', () => {
  const needs = needsEntries(attention, launches, networks, now);
  assert.deepEqual(
    needs.map((n) => [n.title, n.version, n.meta, n.pill?.label]),
    [
      ['Review Pando', 'v1.0.0', '4 drafts · 17 days ago', 'Waiting'],
      ['Retry Sluice', 'v2.0.0', 'claudio was overloaded', 'Failed'],
      ['Answer 2 comments', undefined, undefined, undefined],
      ['Reconnect LinkedIn', undefined, 'José Antonio Garrido', 'Expired'],
    ],
  );
  assert.deepEqual(needs[3]!.run, { kind: 'href', href: '/channels/linkedin' });
  assert.deepEqual(needs[2]!.run, { kind: 'href', href: '/comments?state=waiting' });
});

test('an empty field: needs you with its count, the three newest launches, the three actions, and no Go to', () => {
  const groups = emptyGroups(sources());
  assert.deepEqual(
    groups.map((g) => [g.label, g.count]),
    [
      ['Needs you', 4],
      ['Recent', undefined],
      ['Actions', undefined],
    ],
  );
  const recent = groups[1]!.items;
  assert.deepEqual(
    recent.map((e) => [e.title, e.meta, e.icon]),
    [
      ['Shipcast', 'started 2 min ago', { kind: 'icon', name: 'launches' }],
      ['Sluice', '16 Oct', { kind: 'failed' }],
      ['Pando', '15 Oct', { kind: 'icon', name: 'launches' }],
    ],
  );
  assert.deepEqual(
    groups[2]!.items.map((e) => e.title),
    ['Launch a repo', 'Write an article', 'Connect an account'],
  );
});

test('an article is a text line with "Article" before its date on an empty field', () => {
  const groups = emptyGroups({ ...sources(), launches: [launches[2]!] });
  const article = groups.find((g) => g.id === 'recent')!.items[0]!;
  assert.equal(article.meta, 'Article · 13 Oct');
  assert.deepEqual(article.icon, { kind: 'icon', name: 'text' });
});

test('matching: every word must be there, and the hit is at a word’s start when it can be', () => {
  assert.deepEqual(matchEntry({ title: 'What I learnt shipping slowly' }, 'sl'), { hit: [23, 25], start: true });
  assert.deepEqual(matchEntry({ title: 'Sluice', version: 'v2.0.0' }, 'sluice v2'), { hit: [0, 6], start: true });
  assert.equal(matchEntry({ title: 'Sluice', version: 'v2.0.0' }, 'sluice v3'), null);
  assert.deepEqual(matchEntry({ title: 'Isle' }, 'sl'), { hit: [1, 3], start: false });
  assert.deepEqual(matchEntry({ title: 'Stats', keywords: 'numbers metrics' }, 'metric'), { start: false });
  assert.deepEqual(
    filterEntries(GO_TO, 'set').map((e) => e.title),
    ['Settings', 'AI settings'],
  );
});

test('typing: launches, articles, accounts, sections, actions and needs, at most four each, only groups with matches', () => {
  const groups = typedGroups('sl', sources());
  assert.deepEqual(
    groups.map((g) => g.label),
    ['Launches', 'Articles', 'Needs you'],
  );
  assert.deepEqual(
    groups[0]!.items.map((e) => [e.title, e.version, e.meta, e.hit]),
    [
      ['Sluice', 'v1.4.0', 'yeyo11/sluice · 12 Oct', [0, 2]],
      ['Sluice', 'v2.0.0', 'yeyo11/sluice · 16 Oct', [0, 2]],
    ],
  );
  assert.deepEqual(
    groups[1]!.items.map((e) => e.meta),
    ['13 Oct', '14 Oct'],
  );
  assert.ok(typedGroups('a', sources()).every((g) => g.items.length <= 4));
  assert.deepEqual(
    typedGroups('blue', sources()).map((g) => [g.label, g.items[0]?.meta]),
    [['Accounts', '@josegarrido.dev']],
  );
  assert.deepEqual(
    typedGroups('stats', sources()).map((g) => g.label),
    ['Go to'],
  );
  assert.deepEqual(typedGroups('zebra', sources()), []);
});

test('the Connect step: broken accounts first, then the networks to add, then those connected', () => {
  const groups = connectGroups(networks, '');
  assert.deepEqual(
    groups.map((g) => [g.label, g.count, g.items.map((e) => [e.title, e.meta, e.pill?.label])]),
    [
      ['Needs you', undefined, [['Reconnect LinkedIn', 'José Antonio Garrido', 'Expired']]],
      [
        'Add a network',
        2,
        [
          ['Threads', undefined, undefined],
          ['Reddit', undefined, undefined],
        ],
      ],
      ['Already connected', 1, [['Bluesky', '@josegarrido.dev', 'Connected']]],
    ],
  );
  assert.deepEqual(groups[1]!.items[0]!.run, { kind: 'href', href: '/channels/threads' });
  assert.deepEqual(
    connectGroups(networks, 'red').map((g) => g.items.map((e) => e.title)),
    [['Reddit']],
  );
});

test('nothing matches: launch a repo by that name only when it can be one, and search every launch', () => {
  assert.deepEqual(
    tryGroup('zebra', 'yeyo11').items.map((e) => [e.title, e.meta, e.run]),
    [
      ['Launch a repo called zebra', 'yeyo11/zebra', { kind: 'href', href: '/launch?repo=yeyo11%2Fzebra' }],
      ['Search all launches for “zebra”', 'on the Launches page', { kind: 'href', href: '/?q=zebra' }],
    ],
  );
  assert.deepEqual(
    tryGroup('two words', 'yeyo11').items.map((e) => e.id),
    ['try-search'],
  );
  assert.deepEqual(
    tryGroup('zebra', null).items.map((e) => e.id),
    ['try-search'],
  );
  assert.equal(isRepoName('my.repo-1_x'), true);
  assert.equal(isRepoName('..'), false);
  assert.equal(isRepoName('a/b'), false);
});

test('the two-key shortcuts: N then L launches, N then W writes, anything else nothing', () => {
  assert.equal(sequenceTarget('n', 'l'), '/launch');
  assert.equal(sequenceTarget('N', 'W'), '/write');
  assert.equal(sequenceTarget(null, 'l'), null);
  assert.equal(sequenceTarget('n', 'x'), null);
  assert.equal(sequenceTarget('m', 'l'), null);
  assert.deepEqual(
    ACTIONS.filter((a) => a.keys).map((a) => a.keys),
    [
      ['N', 'L'],
      ['N', 'W'],
    ],
  );
});
