import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agoLabel, draftingNote, laneOf, launchTitle, ownerAvatarUrl, readyPieces, shortDate, shortDateTime, splitLaunches, wordList } from '../src/server/launch-list.ts';

const launch = (id: number, status: string, tone: string) => ({ id, status, state: { tone } });

test('a launch waiting for approval or not out yet leaves the grid; what went out stays', () => {
  assert.equal(laneOf(launch(1, 'drafted', 'waiting')), 'approval');
  // Partly published: some pieces are out, so it is a card with its failures
  assert.equal(laneOf(launch(2, 'drafted', 'failed')), 'out');
  assert.equal(laneOf(launch(3, 'generating', 'draft')), 'pending');
  assert.equal(laneOf(launch(4, 'detected', 'draft')), 'pending');
  assert.equal(laneOf(launch(5, 'skipped', 'quiet')), 'pending');
  assert.equal(laneOf(launch(6, 'published', 'published')), 'out');
  assert.equal(laneOf(launch(7, 'failed', 'failed')), 'out');
});

test('the split keeps the list order within each lane', () => {
  const lanes = splitLaunches([launch(9, 'published', 'published'), launch(8, 'drafted', 'waiting'), launch(7, 'skipped', 'quiet'), launch(6, 'published', 'published'), launch(5, 'drafted', 'waiting')]);
  assert.deepEqual(
    lanes.approval.map((l) => l.id),
    [8, 5],
  );
  assert.deepEqual(
    lanes.pending.map((l) => l.id),
    [7],
  );
  assert.deepEqual(
    lanes.out.map((l) => l.id),
    [9, 6],
  );
  assert.deepEqual(splitLaunches([]), { approval: [], pending: [], out: [] });
});

test('the project picture is its owner’s public GitHub avatar, and only for a real login', () => {
  assert.equal(ownerAvatarUrl('yeyo11/claudio'), 'https://avatars.githubusercontent.com/yeyo11?size=80');
  assert.equal(ownerAvatarUrl('some-org/x'), 'https://avatars.githubusercontent.com/some-org?size=80');
  assert.equal(ownerAvatarUrl('../evil/x'), null);
  assert.equal(ownerAvatarUrl('-bad/x'), null);
  assert.equal(ownerAvatarUrl(''), null);
  assert.equal(ownerAvatarUrl('a--b/x'), null);
});

test('the list names a release by its project and an article by its slug', () => {
  assert.deepEqual(launchTitle({ repo: 'yeyo11/pando', ref: 'v1.0.0' }), { title: 'pando', version: 'v1.0.0', article: false });
  assert.deepEqual(launchTitle({ repo: 'yeyo11/launches', ref: 'article:why-i-moved-my-notes' }), { title: 'Why i moved my notes', version: null, article: true });
});

test('the pieces ready read the article first, then each network once', () => {
  const names = (c: string) => ({ bluesky: 'Bluesky', linkedin: 'LinkedIn', mastodon: 'Mastodon' })[c] ?? c;
  assert.deepEqual(readyPieces(['bluesky', 'blog', 'blog', 'linkedin', 'mastodon'], names), { count: 4, text: 'the article, Bluesky, LinkedIn and Mastodon' });
  assert.deepEqual(readyPieces(['blog'], names), { count: 1, text: 'the article' });
  assert.equal(wordList(['a', 'b']), 'a and b');
});

test('times read as the cards say them', () => {
  const now = new Date('2026-10-31T12:00:00Z');
  assert.equal(agoLabel('2026-10-31T11:57:00Z', now), '3 min ago');
  assert.equal(agoLabel('2026-10-31T10:00:00Z', now), '2 h ago');
  assert.equal(agoLabel('2026-10-30T10:00:00Z', now), 'yesterday');
  assert.equal(shortDate('2026-10-20T10:00:00Z', 'Europe/Madrid', now), '20 Oct');
  assert.equal(shortDate('2025-10-20T10:00:00Z', 'Europe/Madrid', now), '20 Oct 2025');
  assert.equal(shortDateTime('2026-10-20T10:00:00Z', 'Europe/Madrid', now), '20 Oct, 12:00');
});

test('a drafting launch says what it does now, without the aside', () => {
  assert.equal(draftingNote(['Reading the code and writing the pack; this takes a few minutes…']), 'Reading the code and writing the pack');
  assert.equal(draftingNote([]), 'Drafting');
});
