import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { parseSnapshot, type DraftResult, type Launch, type PublishResult, type Registry } from '@shipcast/engine';
import { FakeGitHub } from '@shipcast/engine/testing';
import { Brand } from '@shipcast/schema';
import { BranchState, ciLaunch, ciPublish, GitStateStore, launchTarget, type CiDeps } from '../src/index.ts';

const parseSnapshotText = (text: string | undefined) => parseSnapshot(text ?? '');

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function bareRemote(): string {
  const dir = mkdtempSync(join(tmpdir(), 'shipcast-remote-'));
  dirs.push(dir);
  execFileSync('git', ['init', '-q', '--bare', dir]);
  return dir;
}

const brand = Brand.parse({ id: 'personal', displayName: 'Me', site: 'https://example.dev', github: 'me' });
const RELEASE = { action: 'published', repository: { full_name: 'me/app' }, release: { id: 9, tag_name: 'v1.0.0', prerelease: false, draft: false } };

/** The released repo with its launch.yml at the tag; the fake draft opens no pull request */
function fakeGitHub(): FakeGitHub {
  return new FakeGitHub({
    files: { 'me/app/.github/launch.yml@v1.0.0': 'enabled: true\nbrand: personal\n' },
    latestRelease: { tag: 'v1.0.0', url: 'https://github.com/me/app/releases/tag/v1.0.0' },
    pullRequestState: 'merged',
  }).failOn('openPullRequest', new Error('the fake draft opens no pull request'));
}

/** One workflow run: its own scratch clone of the state, its own log, a draft that only counts */
function run(remote: string, holder: string, drafted: string[], options: { dryRun?: boolean; publish?: CiDeps['publish'] } = {}): { deps: CiDeps; lines: string[] } {
  const lines: string[] = [];
  const deps: CiDeps = {
    launchesRepo: 'me/launches',
    github: fakeGitHub(),
    state: new BranchState(new GitStateStore({ remote }), { holder, leaseMs: 60_000, waitMs: 120_000, pollMs: 200, dryRun: options.dryRun ?? false }),
    brand: async () => brand,
    draft: async (launch: Launch): Promise<DraftResult> => {
      drafted.push(`${launch.repo} ${launch.ref}`);
      return { ok: true, launch, pullRequest: 'https://github.com/me/launches/pull/1' };
    },
    publish:
      options.publish ??
      (async (launch: Launch): Promise<PublishResult> => ({ state: 'waiting', launch, reason: 'not used' })),
    aiLabel: 'the Anthropic API',
    dryRun: options.dryRun ?? false,
    log: (line) => lines.push(line),
    sleep: async () => {},
  };
  return { deps, lines };
}

test('ci launch: a release is claimed, drafted and recorded once; a re-run and a parallel run do nothing', async () => {
  const remote = bareRemote();
  const drafted: string[] = [];
  const target = launchTarget({ eventName: 'release', payload: RELEASE });

  // A dry run first: it says what it would do and leaves no state behind
  const dry = run(remote, 'dry', drafted, { dryRun: true });
  const dryResult = await ciLaunch(dry.deps, target);
  assert.equal(dryResult.outputs.status, 'dry-run');
  assert.match(dry.lines.join('\n'), /would claim me\/app v1\.0\.0/);
  assert.equal((await new GitStateStore({ remote }).read()).sha, undefined, 'nothing pushed');

  // Two runs of the same release at once (a re-run racing the first): exactly one drafts
  const a = run(remote, 'run a', drafted);
  const b = run(remote, 'run b', drafted);
  const [ra, rb] = await Promise.all([ciLaunch(a.deps, target), ciLaunch(b.deps, target)]);
  assert.deepEqual(drafted, ['me/app v1.0.0']);
  assert.deepEqual([ra.outputs.status, rb.outputs.status].sort(), ['already-launched', 'drafted']);
  assert.equal(ra.code + rb.code, 0, 'the run that found it launched still succeeds');

  // A later re-run, from a fresh runner, finds the claim in the state branch
  const again = run(remote, 'run c', drafted);
  const result = await ciLaunch(again.deps, target);
  assert.equal(result.outputs.status, 'already-launched');
  assert.match(again.lines.join('\n'), /launched already \(drafted: https:\/\/github\.com\/me\/launches\/pull\/1\)/);
  assert.deepEqual(drafted, ['me/app v1.0.0']);

  const tip = await new GitStateStore({ remote }).read();
  assert.equal(tip.lock, undefined, 'every lease was released');
  const snapshot = parseSnapshotText(tip.registry);
  assert.equal(snapshot.tables.launches?.length, 1);
  assert.equal(snapshot.tables.launches?.[0]?.status, 'drafted');
});

test('ci publish: a merged pull request is published once its article is live, polling while it deploys', async () => {
  const remote = bareRemote();
  const drafted: string[] = [];
  await ciLaunch(run(remote, 'launch', drafted).deps, launchTarget({ eventName: 'release', payload: RELEASE }));

  let tries = 0;
  const publish = async (launch: Launch, _brand: Brand, registry: Registry): Promise<PublishResult> => {
    tries++;
    if (tries < 3) return { state: 'waiting', launch, reason: 'https://example.dev/en/blog/app/ is not live yet' };
    await registry.recordPost({ launchId: launch.id, channel: 'bluesky', externalId: 'at://1', url: 'https://bsky.app/1' });
    const done = await registry.launches.setStatus(launch.id, 'published');
    return { state: 'published', launch: done, posted: [{ channel: 'bluesky', url: 'https://bsky.app/1' }], problems: [], scheduled: [], failures: [], heldElsewhere: [] };
  };
  const { deps, lines } = run(remote, 'publish', drafted, { publish });
  const result = await ciPublish(deps, { pullRequest: 'https://github.com/me/launches/pull/1', waitMs: 10 * 60_000, retryMs: 1 });
  assert.equal(result.outputs.status, 'published');
  assert.equal(tries, 3);
  assert.match(lines.join('\n'), /bluesky https:\/\/bsky\.app\/1/);

  // The merge's workflow re-run: the launch is published, nothing is posted again
  const rerun = run(remote, 'publish again', drafted, { publish });
  assert.equal((await ciPublish(rerun.deps, { pullRequest: 'https://github.com/me/launches/pull/1', waitMs: 0 })).outputs.status, 'nothing');
  assert.equal(tries, 3);
  const snapshot = parseSnapshotText((await new GitStateStore({ remote }).read()).registry);
  assert.equal(snapshot.tables.posts?.length, 1);
});
