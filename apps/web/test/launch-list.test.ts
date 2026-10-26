import assert from 'node:assert/strict';
import { test } from 'node:test';
import { laneOf, ownerAvatarUrl, splitLaunches } from '../src/server/launch-list.ts';

const launch = (id: number, status: string, tone: string) => ({ id, status, state: { tone } });

test('a launch waiting for approval or not out yet leaves the grid; what went out stays', () => {
  assert.equal(laneOf(launch(1, 'drafted', 'waiting')), 'approval');
  // Partly published: some pieces are out, so it is a card with its failures
  assert.equal(laneOf(launch(2, 'drafted', 'failed')), 'out');
  assert.equal(laneOf(launch(3, 'generating', 'draft')), 'pending');
  assert.equal(laneOf(launch(4, 'detected', 'draft')), 'pending');
  assert.equal(laneOf(launch(5, 'skipped', 'manual')), 'pending');
  assert.equal(laneOf(launch(6, 'published', 'published')), 'out');
  assert.equal(laneOf(launch(7, 'failed', 'failed')), 'out');
});

test('the split keeps the list order within each lane', () => {
  const lanes = splitLaunches([launch(9, 'published', 'published'), launch(8, 'drafted', 'waiting'), launch(7, 'skipped', 'manual'), launch(6, 'published', 'published'), launch(5, 'drafted', 'waiting')]);
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
  assert.equal(ownerAvatarUrl('yeyo11/claudio'), 'https://github.com/yeyo11.png?size=80');
  assert.equal(ownerAvatarUrl('some-org/x'), 'https://github.com/some-org.png?size=80');
  assert.equal(ownerAvatarUrl('../evil/x'), null);
  assert.equal(ownerAvatarUrl('-bad/x'), null);
  assert.equal(ownerAvatarUrl(''), null);
  assert.equal(ownerAvatarUrl('a--b/x'), null);
});
