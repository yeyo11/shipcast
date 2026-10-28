import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConnectorError } from '@shipcast/connectors';
import { Brand } from '@shipcast/schema';
import { publishLaunch, reschedulePost, scheduleLaunch, type Repositories } from '../src/index.ts';
import { aLaunch, FakeClock, FakeConnectors, FakeGitHub, LAUNCHES_REPO, memoryRegistry } from '../src/testing/index.ts';

/*
 * Characterisation: what publishing does today, pinned before PublishingService and the piece state
 * machine replace it (docs/plans/performance-refactor.md, phases 1 and 2). These assert the current
 * strings and cursors on purpose — the `publish-failed:` cursor, the `' (will retry)'` suffix, the
 * order of the problems — so a refactor that changes them does so knowingly. Where today's
 * behaviour looks wrong, the test says so and still pins it.
 */

const brand = Brand.parse({ id: 'personal', displayName: 'Me', site: 'https://josegarrido.dev', github: 'yeyo11' });
const D = 'launches/claudio/v1.0.0';
const failed = (launchId: number, channel: string) => `publish-failed:${launchId}:${channel}`;

const pack = {
  schemaVersion: 1,
  kind: 'launch',
  project: { name: 'claudio', repo: 'https://github.com/yeyo11/claudio', version: 'v1.0.0' },
  analysis: { summary: 's', implemented: ['x'], planned: [], documentedOnly: [], limitations: [] },
  article: { en: { slug: 'claudio', title: 'T', description: 'D', markdown: 'B' } },
  devto: { tags: ['ai'] },
  bluesky: { lang: 'en', text: 'bluesky text' },
  mastodon: { lang: 'en', text: 'mastodon text' },
  telegram: { text: 'telegram text' },
  discord: { text: 'discord text' },
  threads: { text: 'threads text' },
};

/** The launches repo after the merge, and the released repo's launch.yml */
function merged(launchYml: string): FakeGitHub {
  return new FakeGitHub({
    pullRequestState: 'merged',
    files: {
      [`${LAUNCHES_REPO}/${D}/pack.json@HEAD`]: JSON.stringify(pack),
      [`${LAUNCHES_REPO}/src/content/posts/en/claudio.md@HEAD`]: '---\ntitle: "Title"\ndescription: "Description"\n---\n\nBody.\n',
      'yeyo11/claudio/.github/launch.yml@v1.0.0': launchYml,
    },
  });
}

/** The deployed site: every page is live, and the launch image has bytes */
const site = (async (input: string | URL | Request) =>
  String(input).endsWith('/og.jpg') ? new Response(new Uint8Array([0xff, 0xd8, 0xff])) : new Response(null, { status: 200 })) as typeof fetch;

const MIXED = 'enabled: true\nbrand: personal\npublishing:\n  telegram: approval\n  discord: approval\n  threads: approval\n  mastodon: off\n';
const ONLY_BLUESKY = 'enabled: true\nbrand: personal\npublishing:\n  devto: off\n  mastodon: off\n  instagram: off\n  githubDiscussions: off\n';

const rows = async (registry: Repositories, launchId: number) => (await registry.posts.posts(launchId)).map((p) => `${p.channel} ${p.kind} ${p.status} ${p.externalId}`).sort();

test('mixed channels: what goes out, what is recorded, and what each kind of failure leaves for the next round', async () => {
  const registry = await memoryRegistry();
  const launch = await aLaunch(registry);
  const fake = new FakeConnectors();
  fake.fail('bluesky', 'publish', new ConnectorError('Bluesky', 'publish: 503', 503), 1);
  fake.fail('telegram', 'publish', new ConnectorError('Telegram', 'publish: 400 chat not found', 400));
  // Not a ConnectorError and no `retryable`: today that counts as temporary
  fake.fail('discord', 'publish', new Error('socket hang up'), 1);
  // Instagram and GitHub Discussions are on by default but have no publisher; Mastodon has one but is off
  const deps = { github: merged(MIXED), registry, launchesRepo: LAUNCHES_REPO, publishers: fake.publishers(['devto', 'bluesky', 'mastodon', 'telegram', 'discord', 'threads']), fetch: site };

  const first = await publishLaunch(launch, brand, deps);
  assert.ok(first.state === 'partial');
  assert.deepEqual(fake.log, ['devto publish', 'bluesky publish', 'telegram publish', 'discord publish', 'threads publish'], 'in PUBLISHED_BY_ENGINE order, Mastodon left out');
  assert.deepEqual(first.posted, [
    { channel: 'devto', url: 'https://devto.example/1' },
    { channel: 'threads', url: 'https://threads.example/1' },
  ]);
  assert.deepEqual(first.problems, [
    'bluesky: Bluesky: publish: 503 (will retry)',
    'instagram: no piece in the pack or no credentials configured',
    'telegram: Telegram: publish: 400 chat not found',
    'discord: socket hang up (will retry)',
    'githubDiscussions: no piece in the pack or no credentials configured',
  ]);
  assert.deepEqual(first.scheduled, []);
  assert.equal(first.launch.status, 'drafted', 'partial leaves the launch drafted');
  assert.deepEqual(await rows(registry, launch.id), ['blog article:en live claudio', 'devto post live devto-1', 'threads post live threads-1']);
  // Only the permanent failure is remembered, as a cursor holding the network's words
  assert.equal(await registry.cursors.cursor(failed(launch.id, 'telegram')), 'Telegram: publish: 400 chat not found');
  assert.equal(await registry.cursors.cursor(failed(launch.id, 'bluesky')), undefined);
  assert.equal(await registry.cursors.cursor(failed(launch.id, 'discord')), undefined);

  const second = await publishLaunch((await registry.launches.get(launch.id))!, brand, deps);
  assert.ok(second.state === 'published');
  assert.deepEqual(fake.log.slice(5), ['bluesky publish', 'discord publish'], 'the temporary failures again, Telegram not');
  assert.deepEqual(second.posted.map((p) => p.channel), ['bluesky', 'discord']);
  assert.deepEqual(
    second.problems,
    ['instagram: no piece in the pack or no credentials configured', 'githubDiscussions: no piece in the pack or no credentials configured'],
    'a channel with nothing to publish with is reported every round, yet never holds the launch back',
  );
  assert.equal(second.launch.status, 'published', 'published with Telegram failed for good');
  assert.equal(second.launch.detail, launch.detail);

  // A retry of the channel, as the publish job does it: forget the failure, draft the launch again
  await registry.cursors.deleteCursor(failed(launch.id, 'telegram'));
  const retried = await publishLaunch(await registry.launches.setStatus(launch.id, 'drafted', launch.detail), brand, deps);
  assert.ok(retried.state === 'published', 'failing for good again still publishes the launch');
  assert.deepEqual(retried.problems, [
    'instagram: no piece in the pack or no credentials configured',
    'telegram: Telegram: publish: 400 chat not found',
    'githubDiscussions: no piece in the pack or no credentials configured',
  ]);
  assert.equal(await registry.cursors.cursor(failed(launch.id, 'telegram')), 'Telegram: publish: 400 chat not found', 'and is remembered again');

  fake.heal('telegram', 'publish');
  await registry.cursors.deleteCursor(failed(launch.id, 'telegram'));
  const healed = await publishLaunch(await registry.launches.setStatus(launch.id, 'drafted', launch.detail), brand, deps);
  assert.deepEqual(healed.state === 'published' && healed.posted, [{ channel: 'telegram', url: 'https://telegram.example/1' }]);
  assert.equal(fake.callsOf('telegram').length, 3);
  assert.equal(fake.callsOf('devto').length, 1, 'nothing out already went again');
});

test('what counts as temporary: 429, a ConnectorError with no status, anything without `retryable`; `retryable: false` on any error is permanent', async () => {
  const registry = await memoryRegistry();
  const launch = await aLaunch(registry);
  const fake = new FakeConnectors();
  fake.fail('devto', 'publish', new ConnectorError('dev.to', 'publish: 429', 429));
  fake.fail('discord', 'publish', new ConnectorError('Discord', 'timed out'));
  fake.fail('threads', 'publish', Object.assign(new Error('quota spent'), { retryable: false }));
  fake.fail('telegram', 'publish', new ConnectorError('Telegram', 'publish: 500', 500, false));
  const result = await publishLaunch(launch, brand, { github: merged(MIXED), registry, launchesRepo: LAUNCHES_REPO, publishers: fake.publishers(['devto', 'telegram', 'discord', 'threads']), fetch: site });
  assert.ok(result.state === 'partial');
  assert.deepEqual(
    result.problems.filter((p) => !p.includes('no piece in the pack')),
    ['devto: dev.to: publish: 429 (will retry)', 'telegram: Telegram: publish: 500', 'discord: Discord: timed out (will retry)', 'threads: quota spent'],
  );
  assert.equal(await registry.cursors.cursor(failed(launch.id, 'threads')), 'quota spent');
  assert.equal(await registry.cursors.cursor(failed(launch.id, 'telegram')), 'Telegram: publish: 500');
});

test('why a launch waits: no pull request recorded, its pull request open, no pack on main, an unreadable launch.yml; a direct launch skips the pull request', async () => {
  const registry = await memoryRegistry();
  const deps = (github: FakeGitHub) => ({ github, registry, launchesRepo: LAUNCHES_REPO, publishers: {}, fetch: site });
  let n = 0;
  const reason = async (launchDetail: string | null, github: FakeGitHub) => {
    const launch = await aLaunch(registry, { ref: `v0.0.${++n}`, detail: launchDetail });
    const result = await publishLaunch(launch, brand, deps(github));
    return result.state === 'waiting' ? result.reason : result.state;
  };
  const empty = new FakeGitHub({ pullRequestState: 'merged' });
  assert.equal(await reason('https://github.com/yeyo11/launches/tree/main', empty), 'no drafts pull request recorded');
  assert.equal(await reason('https://github.com/yeyo11/launches/pull/3', new FakeGitHub({ pullRequestState: 'open' })), 'the drafts pull request is open');
  assert.match(await reason('https://github.com/yeyo11/launches/pull/3', empty), /^launches\/claudio\/v0\.0\.3\/pack\.json is not on the default branch yet$/);
  assert.match(await reason('direct:sha1 committed', empty), /pack\.json is not on the default branch yet$/, 'direct: no pull request is asked about');
  assert.deepEqual(empty.called('pullRequestState'), [[LAUNCHES_REPO, 3]], 'asked once: the direct launch never asks');

  const launch = await aLaunch(registry, { ref: 'v1.0.0' });
  const noConfig = merged(MIXED);
  delete noConfig.files['yeyo11/claudio/.github/launch.yml@v1.0.0'];
  const result = await publishLaunch(launch, brand, deps(noConfig));
  assert.deepEqual(result.state === 'waiting' && result.reason, '.github/launch.yml of yeyo11/claudio cannot be read');
});

test('a due scheduled piece that fails for now stays scheduled in its slot and is tried each round, until it goes out once', async () => {
  const registry = await memoryRegistry();
  const launch = await aLaunch(registry);
  const clock = new FakeClock();
  const slot = clock.in({ hours: 1 });
  await scheduleLaunch(registry, launch.id, { bluesky: slot }, { now: clock.date });
  const fake = new FakeConnectors();
  const deps = { github: merged(ONLY_BLUESKY), registry, launchesRepo: LAUNCHES_REPO, publishers: fake.publishers(['bluesky']), fetch: site, now: clock.now };

  const early = await publishLaunch(launch, brand, deps);
  assert.deepEqual(early.state === 'partial' && early.scheduled, [{ channel: 'bluesky', at: slot.toISOString() }]);
  assert.equal(fake.calls.length, 0);

  clock.advance({ hours: 1 });
  fake.fail('bluesky', 'publish', new ConnectorError('Bluesky', 'publish: 502', 502), 1);
  const failing = await publishLaunch(launch, brand, deps);
  assert.ok(failing.state === 'partial');
  assert.deepEqual([failing.problems, failing.scheduled], [['bluesky: Bluesky: publish: 502 (will retry)'], []], 'due: no longer listed as scheduled');
  const [waiting] = await registry.posts.posts(launch.id, { channel: 'bluesky' });
  assert.deepEqual([waiting?.status, waiting?.scheduledAt], ['scheduled', slot.toISOString()]);

  const out = await publishLaunch(launch, brand, deps);
  assert.equal(out.state, 'published');
  const [live] = await registry.posts.posts(launch.id, { channel: 'bluesky' });
  assert.deepEqual([live?.id, live?.status, live?.externalId, live?.scheduledAt], [waiting?.id, 'live', 'bluesky-1', slot.toISOString()]);
  await publishLaunch(await registry.launches.setStatus(launch.id, 'drafted', launch.detail), brand, deps);
  assert.equal(fake.callsOf('bluesky').length, 2, 'once out, never again');
});

test('a due scheduled piece that fails for good loses its row, and the launch is published without it', async () => {
  const registry = await memoryRegistry();
  const launch = await aLaunch(registry);
  const clock = new FakeClock();
  await scheduleLaunch(registry, launch.id, { bluesky: clock.in({ minutes: 5 }) }, { now: clock.date });
  const fake = new FakeConnectors().fail('bluesky', 'publish', new ConnectorError('Bluesky', 'publish: 400 invalid', 400));
  clock.advance({ minutes: 5 });
  const result = await publishLaunch(launch, brand, { github: merged(ONLY_BLUESKY), registry, launchesRepo: LAUNCHES_REPO, publishers: fake.publishers(['bluesky']), fetch: site, now: clock.now });
  assert.deepEqual([result.state, result.state === 'published' && result.problems], ['published', ['bluesky: Bluesky: publish: 400 invalid']]);
  assert.deepEqual(await registry.posts.posts(launch.id, { channel: 'bluesky' }), [], 'the scheduled row is cleared');
  assert.equal(await registry.cursors.cursor(failed(launch.id, 'bluesky')), 'Bluesky: publish: 400 invalid');
});

test('a piece moved later waits for its new time', async () => {
  const registry = await memoryRegistry();
  const launch = await aLaunch(registry);
  const clock = new FakeClock();
  const [post] = await scheduleLaunch(registry, launch.id, { bluesky: clock.in({ hours: 1 }) }, { now: clock.date });
  const fake = new FakeConnectors();
  const deps = { github: merged(ONLY_BLUESKY), registry, launchesRepo: LAUNCHES_REPO, publishers: fake.publishers(['bluesky']), fetch: site, now: clock.now };
  await publishLaunch(launch, brand, deps);
  clock.advance({ minutes: 30 });
  const later = clock.in({ hours: 3 });
  await reschedulePost(registry, post!.id, later, { now: clock.date });
  clock.advance({ hours: 1 });
  const waiting = await publishLaunch(launch, brand, deps);
  assert.deepEqual(waiting.state === 'partial' && waiting.scheduled, [{ channel: 'bluesky', at: later.toISOString() }], 'the old time passed: nothing goes');
  clock.set(later);
  assert.equal((await publishLaunch(launch, brand, deps)).state, 'published');
  assert.deepEqual(fake.log, ['bluesky publish']);
});

test('LIKELY BUG: a scheduled piece on a channel with no publisher is left scheduled in a launch marked published', async () => {
  // publish.ts: `if (!run)` reports the channel, and the pending check skips channels without a
  // publisher, so once the slot passes the launch is published while its row still says scheduled
  const registry = await memoryRegistry();
  const launch = await aLaunch(registry);
  const clock = new FakeClock();
  const slot = clock.in({ hours: 1 });
  await scheduleLaunch(registry, launch.id, { bluesky: slot }, { now: clock.date });
  const deps = { github: merged(ONLY_BLUESKY), registry, launchesRepo: LAUNCHES_REPO, publishers: {}, fetch: site, now: clock.now };
  const before = await publishLaunch(launch, brand, deps);
  assert.deepEqual([before.state, before.state === 'partial' && before.scheduled], ['partial', [{ channel: 'bluesky', at: slot.toISOString() }]]);
  clock.advance({ hours: 2 });
  const after = await publishLaunch(launch, brand, deps);
  assert.deepEqual([after.state, after.state === 'published' && after.problems], ['published', ['bluesky: no piece in the pack or no credentials configured']]);
  assert.deepEqual((await registry.posts.posts(launch.id, { channel: 'bluesky' })).map((p) => p.status), ['scheduled']);
});
