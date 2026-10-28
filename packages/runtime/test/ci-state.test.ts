import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { acquireLease, BranchState, GitStateStore, isRejectedPush, LeaseTimeout, LostLease, saveState, type StateLock, type StateStore, type StateTip } from '../src/index.ts';

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A bare repository standing in for the launches repo on GitHub */
function bareRemote(): string {
  const dir = mkdtempSync(join(tmpdir(), 'shipcast-remote-'));
  dirs.push(dir);
  execFileSync('git', ['init', '-q', '--bare', dir]);
  return dir;
}

/** The state branch in memory, refusing a write whose parent is not the tip, as a push without force does */
class MemoryStateStore implements StateStore {
  commits: Array<{ sha: string; registry: string | undefined; lock: StateLock | undefined; message: string }> = [];

  async read(): Promise<StateTip> {
    const tip = this.commits.at(-1);
    return { sha: tip?.sha, registry: tip?.registry, lock: tip?.lock };
  }

  async write(parent: string | undefined, files: { registry: string | undefined; lock: StateLock | undefined }, message: string) {
    if (parent !== this.commits.at(-1)?.sha) return { ok: false as const };
    const sha = `c${this.commits.length + 1}`;
    this.commits.push({ sha, ...files, message });
    return { ok: true as const, sha };
  }
}

const lease = (holder: string, clock: { now: number }) => ({
  holder,
  command: 'test',
  leaseMs: 60_000,
  waitMs: 120_000,
  pollMs: 10_000,
  now: () => clock.now,
  sleep: async (ms: number) => {
    clock.now += ms;
  },
});

test('the lease: a second run waits for the first to release it, then takes it', async () => {
  const store = new MemoryStateStore();
  const clock = { now: Date.parse('2026-10-25T10:00:00Z') };
  const first = await acquireLease(store, lease('run 1', clock));
  assert.equal(first.lock.holder, 'run 1');

  // The second run polls while the first holds it; the first releases during that wait
  const waiting = acquireLease(store, {
    ...lease('run 2', clock),
    sleep: async (ms: number) => {
      clock.now += ms;
      if ((await store.read()).lock?.holder === 'run 1') await saveState(store, first, '{"rows":1}', { ...lease('run 1', clock), release: true, message: 'state' });
    },
  });
  const second = await waiting;
  assert.equal(second.registry, '{"rows":1}', 'the second run starts from what the first saved');
  assert.equal((await store.read()).lock?.holder, 'run 2');
});

test('the lease: a run gives up after waiting, and an expired lease is taken over', async () => {
  const store = new MemoryStateStore();
  const clock = { now: Date.parse('2026-10-25T10:00:00Z') };
  const first = await acquireLease(store, lease('run 1', clock));
  await assert.rejects(acquireLease(store, { ...lease('run 2', clock), waitMs: 30_000 }), LeaseTimeout);

  clock.now += 61_000;
  const lines: string[] = [];
  const taken = await acquireLease(store, { ...lease('run 3', clock), log: (l) => lines.push(l) });
  assert.equal(taken.lock.holder, 'run 3');
  assert.match(lines.join('\n'), /Taking over the state from run 1/);
  // The first run, back from the dead, cannot overwrite what the third does
  await assert.rejects(saveState(store, first, '{}', { ...lease('run 1', clock), release: true, message: 'state' }), LostLease);
});

test('the lease: two runs racing for it at once, one wins and the other waits', async () => {
  const store = new MemoryStateStore();
  const clock = { now: Date.parse('2026-10-25T10:00:00Z') };
  const [a, b] = await Promise.allSettled([acquireLease(store, { ...lease('a', clock), waitMs: 0 }), acquireLease(store, { ...lease('b', clock), waitMs: 0 })]);
  const won = [a, b].filter((r) => r.status === 'fulfilled');
  assert.equal(won.length, 1);
  assert.ok([a, b].some((r) => r.status === 'rejected' && r.reason instanceof LeaseTimeout));
});

test('the git store: a first commit, a read back, and a write on a stale parent refused', async () => {
  const remote = bareRemote();
  const store = new GitStateStore({ remote });
  const other = new GitStateStore({ remote });
  try {
    assert.deepEqual(await store.read(), { sha: undefined, registry: undefined, lock: undefined });
    const lock: StateLock = { holder: 'run 1', command: 'test', since: '2026-10-25T10:00:00.000Z', expires: '2026-10-25T10:30:00.000Z' };
    const first = await store.write(undefined, { registry: '{"a":1}\n', lock }, 'lock');
    assert.ok(first.ok);

    // A second first commit loses the race: the branch exists now
    assert.equal((await other.write(undefined, { registry: undefined, lock: undefined }, 'lock')).ok, false);

    const tip = await other.read();
    assert.equal(tip.sha, first.ok ? first.sha : '');
    assert.equal(tip.registry, '{"a":1}\n');
    assert.deepEqual(tip.lock, lock);

    const second = await other.write(tip.sha, { registry: '{"a":2}\n', lock: undefined }, 'state');
    assert.ok(second.ok);
    // The first store still thinks the tip is its own commit: refused, not forced
    assert.equal((await store.write(tip.sha, { registry: '{"a":3}\n', lock: undefined }, 'state')).ok, false);
    const last = await store.read();
    assert.equal(last.registry, '{"a":2}\n');
    assert.equal(last.lock, undefined);
    const files = execFileSync('git', ['--git-dir', remote, 'ls-tree', '--name-only', 'shipcast-state'], { encoding: 'utf8' }).trim().split('\n');
    assert.deepEqual(files.sort(), ['README.md', 'registry.json']);
  } finally {
    await store.close();
    await other.close();
  }
});

test('git output that means the branch moved is told apart from other failures', () => {
  assert.ok(isRejectedPush(' ! [rejected]        abc -> shipcast-state (fetch first)'));
  assert.ok(isRejectedPush('error: failed to push some refs\nhint: Updates were rejected because the tip of your current branch is behind (non-fast-forward)'));
  assert.ok(isRejectedPush(' ! [remote rejected] f118472 -> shipcast-state (reference already exists)'), 'two first runs creating the branch at once');
  assert.ok(!isRejectedPush('fatal: Authentication failed for https://github.com/o/r.git'));
});

test('the branch state: a run saves its registry and frees the lease; a dry run saves nothing', async () => {
  const remote = bareRemote();
  const options = { holder: 'run 1', leaseMs: 60_000, waitMs: 60_000 };
  const state = new BranchState(new GitStateStore({ remote }), options);
  const release = { repo: 'o/app', ref: 'v1.0.0', trigger: 'release' as const, kind: 'launch' as const, brand: 'personal' };
  try {
    const first = await state.use((registry) => registry.launches.claim(release));
    assert.equal(first.claimed, true);
    const tip = await new GitStateStore({ remote }).read();
    assert.equal(tip.lock, undefined, 'the lease is released');
    assert.match(tip.registry ?? '', /"o\/app"/);

    const dry = new BranchState(new GitStateStore({ remote }), { ...options, dryRun: true });
    const again = await dry.use((registry) => registry.launches.claim({ ...release, ref: 'v2.0.0' }));
    assert.equal(again.claimed, true, 'claimed in the dry run’s copy');
    assert.equal((await new GitStateStore({ remote }).read()).sha, tip.sha, 'and nothing pushed');

    // A failure inside the work still saves what was done before it, and frees the lease
    await assert.rejects(
      state.use(async (registry) => {
        await registry.setCursor('seen', 'yes');
        throw new Error('boom');
      }),
      /boom/,
    );
    const after = await new GitStateStore({ remote }).read();
    assert.equal(after.lock, undefined);
    assert.match(after.registry ?? '', /"seen"/);
  } finally {
    await state.close();
  }
});
