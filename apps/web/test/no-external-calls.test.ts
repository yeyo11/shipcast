import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LaunchReadService, LaunchService, type ReviewGitHub } from '@shipcast/engine';
import { memoryRegistry, MemoryMediaStore } from '@shipcast/engine/testing';
import { Flags, instrumentFetch, MemoryStore, withOrigin, type CallSample, type TelemetryRecorder } from '@shipcast/runtime';
import { MemoryCache } from '@shipcast/runtime/redis';
import { Brand } from '@shipcast/schema';
import { commentService, scheduleService } from '../src/server/app-services.ts';
import { attentionFor } from '../src/server/attention.server.ts';
import { automationView } from '../src/server/automation.server.ts';
import { channelsViewOf } from '../src/server/channels-view.server.ts';
import { commentView } from '../src/server/comment-view.ts';
import { jobsPage } from '../src/server/jobs.server.ts';
import { profileView } from '../src/server/profile-api.ts';
import { repoList } from '../src/server/repo-list.ts';
import { launchPage } from '../src/server/launch-page.server.ts';
import { launchNumbers, postAccounts, readTimezone } from '../src/server/launch-summary.server.ts';
import { launchView } from '../src/server/launches.server.ts';
import { DEFAULTS } from '../src/server/stats-search.ts';
import { loadGrowth, loadSearch, loadStats } from '../src/server/stats.server.ts';

/*
 * Phase 7's exit (docs/plans/performance-refactor.md): with `github-events` on, no page's server
 * function reaches outside the process. Each loader runs under its telemetry origin, with the global
 * fetch counted and made to throw and a GitHub client that throws on any call, so a loader that
 * reaches GitHub (or any provider) fails here instead of costing a request on every view.
 */

const LAUNCHES = 'yeyo11/launches';
const D = 'launches/claudio/v1.0.0';
/** A launch's usual pull request: both articles, every channel's text, its media and its pack */
const FILES = [
  'src/content/posts/en/claudio.md',
  'src/content/posts/es/claudio.md',
  ...['bluesky', 'mastodon', 'threads', 'linkedin', 'devto', 'hashnode', 'reddit', 'telegram'].map((c) => `${D}/${c}.md`),
  `public/${D}/og.jpg`,
  `public/${D}/demo.mp4`,
  `${D}/pack.json`,
];

/** A GitHub that fails any call: the test's proof that the registry alone answered */
const unreachable = new Proxy({} as ReviewGitHub, {
  get: (_target, name) => () => Promise.reject(new Error(`GitHub was called: ${String(name)}`)),
});

/** Runs `work` with the global fetch counted under `origin` and throwing, and answers what was counted */
async function counted(origin: string, work: () => Promise<unknown>): Promise<CallSample[]> {
  const samples: CallSample[] = [];
  const recorder = { call: (sample: CallSample) => samples.push(sample) } as unknown as TelemetryRecorder;
  const original = globalThis.fetch;
  globalThis.fetch = instrumentFetch((async (input: Parameters<typeof fetch>[0]) => {
    throw new Error(`an outbound call from ${origin}: ${String(input)}`);
  }) as typeof fetch, recorder);
  try {
    await withOrigin(origin, work);
  } finally {
    globalThis.fetch = original;
  }
  return samples;
}

async function seeded() {
  const registry = await memoryRegistry();
  const { launch } = await registry.launches.claim({ repo: 'yeyo11/claudio', ref: 'v1.0.0', trigger: 'release', kind: 'launch', brand: 'personal' });
  const drafted = await registry.launches.setStatus(launch.id, 'drafted', `https://github.com/${LAUNCHES}/pull/7`);
  await registry.drafts.saveSnapshot({
    launchId: launch.id,
    pullRequest: { number: 7, url: `https://github.com/${LAUNCHES}/pull/7`, state: 'open', branch: 'launch/claudio-v1.0.0' },
    headSha: 'abc',
    launchYml: 'brand: personal\npublishing:\n  bluesky: approval\n',
    files: FILES.map((path) => ({ path, sha: `sha-${path}`, content: path.endsWith('.md') ? `# ${path}\n` : null })),
  });
  return { registry, launch: drafted };
}

test('getLaunch with 13 drafts reads only the registry: no outbound call, GitHub never asked', async () => {
  const { registry, launch } = await seeded();
  let page: Awaited<ReturnType<typeof launchPage>> | undefined;
  const calls = await counted('fn:getLaunch', async () => {
    page = await launchPage({ registry, github: unreachable, launchesRepo: LAUNCHES, drafts: { get: (id) => registry.drafts.snapshot(id) } }, launch);
  });
  assert.deepEqual(calls, []);
  assert.ok(page);
  assert.ok(page.review && !('error' in page.review), 'the drafts came from the snapshot, not from an error');
  assert.equal(page.review.drafts.length, 13);
  assert.equal(page.review.pullRequest?.state, 'open');
  assert.equal(page.review.drafts.find((d) => d.path === `${D}/bluesky.md`)?.content, `# ${D}/bluesky.md\n`);
  assert.ok(page.draftsReadAt, 'the page says when the drafts were read');
});

test('without the snapshot the same loader reads GitHub, as before the flag', async () => {
  const { registry, launch } = await seeded();
  const page = await launchPage({ registry, github: unreachable, launchesRepo: LAUNCHES }, launch);
  assert.ok(page.review && 'error' in page.review && /GitHub was called/.test(page.review.error));
  assert.equal('draftsReadAt' in page, false);
});

/*
 * The launch model's fourth phase (docs/launch-store-read.md): with `launch-store-read`, a launch the
 * launch model's tables hold is read from them alone, with no snapshot at all: its drafts, its files
 * served by the app and the channels it can still schedule, as launch.yml's rows say them.
 */
async function stored() {
  const registry = await memoryRegistry();
  const media = new MemoryMediaStore();
  const { launch } = await registry.launches.claim({ repo: 'yeyo11/claudio', ref: 'v1.0.0', trigger: 'release', kind: 'launch', brand: 'personal' });
  const drafted = await registry.launches.setStatus(launch.id, 'drafted', `https://github.com/${LAUNCHES}/pull/7`);
  const store = registry.launchStore;
  await store.addPack(launch.id, { schemaVersion: 1 });
  await store.replaceChannels(launch.id, [{ channel: 'bluesky', mode: 'approval' }, { channel: 'mastodon', mode: 'off' }, { channel: 'threads', mode: 'approval' }], 'enabled: true\nbrand: personal\npublishing:\n  bluesky: approval\n  mastodon: approval\n  threads: approval\n');
  await store.addVersion(launch.id, { channel: 'bluesky', piece: 'post', body: '# Bluesky\n\nhello\n', fields: { path: `${D}/bluesky.md` }, origin: 'ai' });
  const put = await media.put(new Uint8Array([1, 2, 3]), 'image/jpeg');
  await store.addMedia({ launchId: launch.id, sha256: put.sha256, kind: 'image', mime: 'image/jpeg', bytes: 3, storage: media.storage, path: put.key, role: 'og', publicPath: `/${D}/og.jpg` });
  return { registry, launch: drafted, read: new LaunchReadService({ registry, media }) };
}

test('with launch-store-read, getLaunch reads the launch model alone: no outbound call, GitHub never asked', async () => {
  const { registry, launch, read } = await stored();
  let page: Awaited<ReturnType<typeof launchPage>> | undefined;
  const calls = await counted('fn:getLaunch', async () => {
    page = await launchPage({ registry, github: unreachable, launchesRepo: LAUNCHES, stored: read }, launch);
  });
  assert.deepEqual(calls, []);
  assert.ok(page?.review && !('error' in page.review), 'the drafts came from the tables, not from an error');
  assert.equal(page.review.pullRequest?.state, 'open');
  assert.equal(page.review.drafts.find((d) => d.path === `${D}/bluesky.md`)?.content, '# Bluesky\n\nhello\n');
  assert.match(page.review.drafts.find((d) => d.kind === 'image')?.url ?? '', /^\/media\/\d+$/, 'served by the app, not GitHub');
  assert.equal('draftsReadAt' in page, false);
  const channels = page.pieces.scheduling.channels.map((c) => c.channel);
  assert.ok(channels.includes('bluesky') && channels.includes('threads'));
  assert.ok(!channels.includes('mastodon'), 'a channel its row turns off cannot be scheduled');
});

test('with launch-store-read, scheduling reads the channels from the tables', async () => {
  const { registry, launch, read } = await stored();
  const schedule = scheduleService({ registry, armSchedule: async () => {}, github: unreachable, launchesRepo: LAUNCHES, launchRead: read });
  const at = new Date(Date.now() + 86_400_000);
  await assert.rejects(schedule.schedule(launch.id, { mastodon: at }));
  const [post] = await schedule.schedule(launch.id, { bluesky: at });
  assert.equal(post?.status, 'scheduled');
});

test("the launches list and the stats pages' loaders make no outbound call", async () => {
  const { registry, launch } = await seeded();
  const calls = [
    ...(await counted('fn:listLaunches', async () => {
      const { page } = await new LaunchService({ launches: registry.launches, claims: undefined as never, github: undefined as never }).page({ pageSize: 24 });
      await Promise.all([Promise.all(page.launches.map((l) => launchView(registry, l))), launchNumbers(registry, page.launches), postAccounts(registry, page.launches), readTimezone(registry)]);
      assert.equal(page.launches[0]?.id, launch.id);
    })),
    ...(await counted('fn:loadStats', () => loadStats(registry, DEFAULTS, '2026-10-28'))),
    ...(await counted('fn:loadGrowth', () => loadGrowth(registry, { from: '2026-10-01', to: '2026-10-28' }))),
    ...(await counted('fn:loadSearch', () => loadSearch(registry, { from: '2026-10-01', to: '2026-10-28' }))),
  ];
  assert.deepEqual(calls, []);
});

/*
 * Phase 9 (realtime-ui): every route's loader, not only the launch page's. What each page's server
 * function reads, run on a seeded registry with fetch throwing: the list, a launch (above), the
 * comments, the stats (above), the channels, Automation and its jobs, the bell, a profile review, and
 * the one list only GitHub has (the repositories of "Launch a repo"), which is a cached read.
 */
test("the comments, channels, automation, bell and profile loaders make no outbound call", async () => {
  const { registry, launch } = await seeded();
  const { post } = await registry.posts.recordPost({ launchId: launch.id, channel: 'bluesky', externalId: 'at://1', url: 'https://bsky.app/1' });
  await registry.comments.recordComment({ postId: post.id, channel: 'bluesky', externalId: 'c1', author: { handle: 'someone' }, text: 'Nice', createdAt: new Date().toISOString(), own: false });
  const account = await registry.accounts.addAccount({ network: 'bluesky', brand: 'personal', label: 'Me', settings: { handle: 'me.bsky.social' } });
  await registry.jobs.recordJob({ id: 'job-1', queue: 'draft', title: 'Drafting', launchId: launch.id });
  const brand = Brand.parse({ id: 'personal', displayName: 'Me', site: 'https://josegarrido.dev', github: 'yeyo11' });
  const calls = [
    ...(await counted('fn:listComments', async () => {
      const comments = commentService({ registry });
      const { page } = await comments.page({ own: false });
      assert.equal(page.comments.map(commentView).length, 1);
      await comments.settings();
    })),
    ...(await counted('fn:getChannels', async () => {
      const view = await channelsViewOf({ registry, secrets: new MemoryStore(), brand: async () => brand, settings: { oauthApp: () => undefined }, flags: new Flags() });
      assert.equal(view.networks.find((n) => n.id === 'bluesky')?.accounts.length, 1);
    })),
    ...(await counted('fn:getAutomation', async () => {
      await automationView({ registry });
      assert.equal((await jobsPage(registry, { page: 1, state: 'all' })).jobs.length, 1);
    })),
    ...(await counted('fn:getAttention', () => attentionFor(registry))),
    ...(await counted('fn:getProfileReview', () => profileView(registry, account.id))),
  ];
  assert.deepEqual(calls, []);
});

test('the repositories of "Launch a repo" are a cached read: GitHub once, then the cache', async () => {
  const cache = new MemoryCache();
  let asked = 0;
  const github = { userRepos: async () => (asked++, [{ repo: 'yeyo11/claudio', description: null, pushedAt: '2026-10-01T00:00:00Z' }]) };
  await repoList({ github, cache }, 'yeyo11');
  const calls = await counted('fn:listRepos', async () => {
    const repos = await repoList({ github: { userRepos: () => Promise.reject(new Error('GitHub was called')) }, cache }, 'yeyo11');
    assert.equal(repos[0]?.repo, 'yeyo11/claudio');
  });
  assert.deepEqual(calls, []);
  assert.equal(asked, 1);
});

test('the counting fetch would see a loader that reached out, under its origin', async () => {
  const calls = await counted('fn:getLaunch', () => fetch('https://api.github.com/repos/yeyo11/launches/pulls/7').catch(() => undefined));
  assert.equal(calls.length, 1, 'the harness itself catches a call');
  assert.equal(calls[0]?.origin, 'fn:getLaunch');
  assert.equal(calls[0]?.provider, 'github');
});
