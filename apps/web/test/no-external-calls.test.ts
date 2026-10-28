import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LaunchService, type ReviewGitHub } from '@shipcast/engine';
import { memoryRegistry } from '@shipcast/engine/testing';
import { instrumentFetch, withOrigin, type CallSample, type TelemetryRecorder } from '@shipcast/runtime';
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
  assert.equal(page.review.pullRequest.state, 'open');
  assert.equal(page.review.drafts.find((d) => d.path === `${D}/bluesky.md`)?.content, `# ${D}/bluesky.md\n`);
  assert.ok(page.draftsReadAt, 'the page says when the drafts were read');
});

test('without the snapshot the same loader reads GitHub, as before the flag', async () => {
  const { registry, launch } = await seeded();
  const page = await launchPage({ registry, github: unreachable, launchesRepo: LAUNCHES }, launch);
  assert.ok(page.review && 'error' in page.review && /GitHub was called/.test(page.review.error));
  assert.equal('draftsReadAt' in page, false);
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

test('the counting fetch would see a loader that reached out, under its origin', async () => {
  const calls = await counted('fn:getLaunch', () => fetch('https://api.github.com/repos/yeyo11/launches/pulls/7').catch(() => undefined));
  assert.equal(calls.length, 1, 'the harness itself catches a call');
  assert.equal(calls[0]?.origin, 'fn:getLaunch');
  assert.equal(calls[0]?.provider, 'github');
});
