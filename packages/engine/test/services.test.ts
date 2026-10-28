import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Launch, PublishResult } from '../src/index.ts';
import { draftNotice, LaunchRefused, publishAgain, PublishRefused, LaunchService, NotificationService, PostService, publishNotice, ScheduleService, type ReviewGitHub } from '../src/index.ts';
import { aPublishedLaunch, FakeConnectors, FakeGitHub, memoryRegistry } from '../src/testing/index.ts';

/* The application services over the engine's operations, on PGlite with the networks faked */

const launch = { repo: 'yeyo11/claudio', ref: 'v2.0.0' } as Launch;
const outcome = (o: Partial<Extract<PublishResult, { state: 'published' | 'partial' }>>): PublishResult => ({
  state: 'partial',
  launch,
  posted: [],
  problems: [],
  scheduled: [],
  failures: [],
  heldElsewhere: [],
  ...o,
});

test('one rule tells the owner what a publish run did, for the job and the round alike', () => {
  const posted = [{ channel: 'mastodon' as const, url: 'https://m.example/1' }];
  const retryable = { problems: ['devto: 503'], failures: [{ channel: 'devto' as const, message: '503', retryable: true }] };
  assert.equal(publishNotice(launch, { state: 'waiting', launch, reason: 'the site has not deployed' }, { final: true }), undefined);
  assert.equal(publishNotice(launch, { state: 'skipped', launch }, { final: true }), undefined);
  assert.equal(publishNotice(launch, outcome({}), { final: true }), undefined, 'no news');
  assert.equal(publishNotice(launch, outcome({ state: 'published', posted }), { final: false }), 'Shipcast published yeyo11/claudio v2.0.0: https://m.example/1');
  assert.equal(publishNotice(launch, outcome(retryable), { final: false }), undefined, 'the next attempt may clear it');
  assert.equal(publishNotice(launch, outcome(retryable), { final: true }), 'Shipcast published yeyo11/claudio v2.0.0 in part: devto: 503');
  assert.equal(publishNotice(launch, outcome({ ...retryable, posted }), { final: false }), 'Shipcast published yeyo11/claudio v2.0.0 in part: devto: 503', 'something went out: worth saying now');
  assert.equal(
    publishNotice(launch, outcome({ posted, scheduled: [{ channel: 'bluesky', at: '2030-01-01T10:00:00.000Z' }] }), { final: false }),
    'Shipcast published yeyo11/claudio v2.0.0: https://m.example/1; scheduled: bluesky at 2030-01-01T10:00:00.000Z',
  );
});

test('a notice that cannot go out never fails the work, and drafts say where to review them', async () => {
  const said: string[] = [];
  await new NotificationService({ notify: async () => Promise.reject(new Error('Telegram is down')) }).say('x');
  const service = new NotificationService({ notify: async (text) => said.push(text) });
  await service.drafted(launch, { ok: true, launch, pullRequest: 'https://github.com/yeyo11/launches/pull/9' });
  await service.drafted(launch, { ok: false, launch, problems: ['no launch.yml'] }, { article: 'Hello' });
  assert.deepEqual(said, ['Shipcast drafted yeyo11/claudio v2.0.0: review the drafts at https://github.com/yeyo11/launches/pull/9', 'Shipcast could not draft the article “Hello”: no launch.yml']);
  assert.equal(draftNotice({ repo: 'yeyo11/launches', ref: 'article:hello' }, { ok: true, launch, pullRequest: 'p' }), 'Shipcast drafted yeyo11/launches hello: review the drafts at p');
  await new NotificationService(undefined).say('nobody listens');
});

test('the post service edits by piece or by channel through the one multi-edit, and confirms a whole delete by the repo', async () => {
  const registry = await memoryRegistry();
  const fake = new FakeConnectors();
  const { launch: l, posts } = await aPublishedLaunch(registry, [
    { channel: 'mastodon', externalId: 'm1' },
    { channel: 'telegram', externalId: '@c:5', status: 'deleted' },
  ]);
  const service = new PostService({ launches: registry, editing: async () => ({ registry, editors: fake.editors() }) });
  const [mastodon, telegram] = posts;
  const byId = await service.editMany(l.id, { text: 'T' }, { postIds: [telegram!.id, 9999, mastodon!.id] });
  assert.deepEqual(byId.map((o) => `${o.postId === 9999 ? 'missing' : o.channel} ${o.ok ? o.post.status : o.reason}`), ['telegram deleted', 'missing not_found', 'mastodon edited']);
  const byChannel = await service.editMany(l.id, { text: 'T' }, undefined);
  assert.deepEqual(byChannel.map((o) => o.channel), ['mastodon'], 'a deleted piece is not there to change');

  await assert.rejects(service.deleteLaunch(l.id, 'yeyo11/other'), (e: unknown) => e instanceof Error && e.message === `type ${l.repo} to confirm`);
  await assert.rejects(service.deleteLaunch(999, l.repo), /no such launch/);
  assert.deepEqual((await service.deleteLaunch(l.id, l.repo)).map((o) => o.ok), [true]);
});

test('the schedule service checks launch.yml at best, and arms every piece it sets or moves', async () => {
  const registry = await memoryRegistry();
  const { launch: l } = await registry.claim({ repo: 'yeyo11/claudio', ref: 'v3.0.0', trigger: 'release', kind: 'launch', brand: 'personal' });
  await registry.setStatus(l.id, 'drafted');
  const armed: string[] = [];
  const at = new Date(Date.now() + 86_400_000);
  const service = new ScheduleService({
    store: registry,
    recommendations: registry,
    launchConfig: async () => Promise.reject(new Error('launch.yml cannot be read yet')),
    arm: async (posts) => void armed.push(...posts.map((p) => p.channel)),
  });
  const [bluesky] = await service.schedule(l.id, { bluesky: at });
  await service.move(bluesky!.id, new Date(at.getTime() + 3600_000));
  assert.deepEqual(armed, ['bluesky', 'bluesky']);
  await assert.rejects(service.schedule(999, { bluesky: at }), /no such launch/);
  assert.equal((await service.cancel(bluesky!.id)).channel, 'bluesky');
  assert.equal(await service.setTimezone('America/New_York'), 'America/New_York');
  assert.equal(await service.timezone(), 'America/New_York');
});

test('the launch service refuses a launch whose pre-flight fails; publishing again follows only what it may', async () => {
  const registry = await memoryRegistry();
  const github = new FakeGitHub();
  // A repo with nothing in it: no release, no files, no license
  const bare = {
    releaseByTag: async () => undefined,
    latestRelease: async () => undefined,
    fileAt: async () => undefined,
    license: async () => undefined,
    hasReadme: async () => false,
    pathExists: async () => false,
    head: async () => 404,
    pullRequest: github.pullRequest.bind(github),
    pullRequestFiles: github.pullRequestFiles.bind(github),
    updateFile: github.updateFile.bind(github),
    mergePullRequest: github.mergePullRequest.bind(github),
  } satisfies ReviewGitHub & Record<string, unknown>;
  const service = new LaunchService({ launches: registry, claims: { registry, github, launchesRepo: 'yeyo11/launches' }, github: bare });
  await assert.rejects(// The pre-flight refuses before the brand is read
    service.claimManual('yeyo11/nothing', 'v1.0.0', () => Promise.reject(new Error('the brand is never read'))), (e: unknown) => e instanceof LaunchRefused && e.reason === 'not_ready');
  await assert.rejects(service.approve(999), (e: unknown) => e instanceof LaunchRefused && e.reason === 'not_found');

  const { launch: l } = await registry.claim({ repo: 'yeyo11/claudio', ref: 'v1.0.0', trigger: 'release', kind: 'launch', brand: 'personal' });
  await registry.setStatus(l.id, 'published');
  await assert.rejects(publishAgain(registry, l.id, undefined), (e: unknown) => e instanceof PublishRefused && e.message === 'the launch is published');
  assert.equal((await publishAgain(registry, l.id, 'devto')).status, 'drafted', 'a channel with nothing out reopens the launch');
  await assert.rejects(publishAgain(registry, 999, 'devto'), /no such launch/);
});
