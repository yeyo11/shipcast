import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GitHubError, preflight, type PreflightSource, type ReviewGitHub } from '@shipcast/engine';
import { memoryRegistry } from '@shipcast/engine/testing';
import { createApiToken, MemoryStore } from '@shipcast/runtime';
import { MemoryCache } from '@shipcast/runtime/redis';
import { FailureLimiter, handleApi, openApiDocument, type ApiDeps } from '../src/server/api.ts';
import { reposService } from '../src/server/repos.server.ts';

/* The repos routes, on a PGlite registry with GitHub faked: the repo list, the releases and the pre-flight */

const unused = async (): Promise<never> => {
  throw new Error('the repos routes start no work');
};

const REPOS = [{ repo: 'yeyo11/claudio', description: 'An AI provider', pushedAt: '2026-10-30T10:00:00Z' }];
const RELEASES = [
  { tag: 'v1.1.0', name: 'v1.1.0', publishedAt: '2026-10-30T10:00:00Z', prerelease: false },
  { tag: 'v1.0.0', name: 'First', publishedAt: '2026-10-01T10:00:00Z', prerelease: false },
];

/** A repo ready to launch at v1.1.0, read only through what the pre-flight asks */
const READY: PreflightSource = {
  releaseByTag: async (_repo, tag) => (RELEASES.some((r) => r.tag === tag) ? { tag, url: `https://github.com/yeyo11/claudio/releases/${tag}`, draft: false } : undefined),
  latestRelease: async () => ({ tag: 'v1.1.0', url: 'https://github.com/yeyo11/claudio/releases/v1.1.0' }),
  fileAt: async () => 'enabled: true\nbrand: personal\n',
  license: async () => ({ spdx: 'MIT' }),
  hasReadme: async () => true,
  pathExists: async () => true,
  head: async () => 200,
};

async function setup(options: { failing?: number; withoutRepos?: boolean } = {}) {
  const registry = await memoryRegistry();
  const secrets = new MemoryStore();
  const asked: string[] = [];
  const fail = () => {
    if (options.failing) throw new GitHubError(`GitHub GET: ${options.failing}`, options.failing);
  };
  const github = {
    userRepos: async (owner: string) => {
      asked.push(`repos ${owner}`);
      fail();
      return REPOS;
    },
    releases: async (repo: string) => {
      asked.push(`releases ${repo}`);
      fail();
      return RELEASES;
    },
  };
  const source: PreflightSource = {
    ...READY,
    latestRelease: async (repo) => {
      asked.push(`latest ${repo}`);
      fail();
      return READY.latestRelease(repo);
    },
  };
  // The process's shared cache, as Redis's would answer: a second read within its time is not GitHub's
  const cache = new MemoryCache();
  const deps: ApiDeps = {
    registry,
    secrets,
    github: {} as ReviewGitHub,
    launchesRepo: 'yeyo11/launches',
    launchRead: { review: async () => undefined, channelConfig: async () => undefined },
    publicUrl: 'https://shipcast.example',
    limiter: new FailureLimiter(),
    jobs: async () => ({ jobs: [], next: null }),
    startLaunch: unused,
    approve: unused,
    startArticle: unused,
    startPublishing: unused,
    editing: unused,
    armSchedule: unused,
    comments: unused,
    checkComments: unused,
    redraftComment: unused,
    ...(!options.withoutRepos && {
      repos: reposService({
        github,
        preflight: (repo, ref) => preflight(repo, ref, { github: source }),
        cache,
        registry,
        owner: async () => 'yeyo11',
      }),
    }),
  };
  const tokens = { registry, secrets };
  return { deps, registry, asked, read: (await createApiToken(tokens, 'reader', ['read'])).token };
}

async function call(deps: ApiDeps, path: string, token: string) {
  const response = await handleApi(new Request(`https://shipcast.example/api/v1${path}`, { headers: { authorization: `Bearer ${token}` } }), deps);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> & { error?: { code: string; message: string } } };
}

test('the repos to launch from are the owner’s, read from GitHub once per cache time', async () => {
  const s = await setup();
  const first = await call(s.deps, '/repos', s.read);
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, { owner: 'yeyo11', repos: REPOS });
  assert.equal((await call(s.deps, '/repos', s.read)).status, 200);
  assert.deepEqual(s.asked, ['repos yeyo11'], 'the second read came from the cache');
});

test('a repo’s releases say which were launched already, whatever the launch’s status', async () => {
  const s = await setup();
  const { launch } = await s.registry.launches.claim({ repo: 'yeyo11/claudio', ref: 'v1.0.0', trigger: 'release', kind: 'launch', brand: 'personal' });
  await s.registry.launches.setStatus(launch.id, 'failed', 'the analysis failed');
  // Another repo's launch of the same tag is not this one's
  await s.registry.launches.claim({ repo: 'yeyo11/sluice', ref: 'v1.1.0', trigger: 'release', kind: 'launch', brand: 'personal' });
  const listed = await call(s.deps, '/repos/releases?repo=yeyo11/claudio', s.read);
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body, {
    repo: 'yeyo11/claudio',
    releases: [
      { ...RELEASES[0], launch: null },
      { ...RELEASES[1], launch: { id: launch.id, status: 'failed' } },
    ],
  });
});

test('the pre-flight runs alone, at the tag asked or the latest release, and claims nothing', async () => {
  const s = await setup();
  const latest = await call(s.deps, '/repos/preflight?repo=yeyo11/claudio', s.read);
  assert.equal(latest.status, 200);
  assert.equal(latest.body.ok, true);
  assert.equal(latest.body.ref, undefined);
  assert.deepEqual(s.asked, ['latest yeyo11/claudio']);
  const tagged = await call(s.deps, '/repos/preflight?repo=yeyo11/claudio&ref=v0.9.0', s.read);
  assert.equal(tagged.status, 200);
  assert.equal(tagged.body.ok, false);
  assert.equal(tagged.body.ref, 'v0.9.0');
  assert.match(String((tagged.body.checks as Array<{ id: string; detail: string }>).find((c) => c.id === 'release')?.detail), /no release tagged v0\.9\.0/);
  assert.equal((await s.registry.launches.recent()).length, 0, 'nothing was launched');
});

test('a repo is owner/name and a ref a tag; anything else is a 400 before GitHub is asked', async () => {
  const s = await setup();
  for (const path of ['/repos/releases', '/repos/releases?repo=claudio', '/repos/preflight?repo=yeyo11/claudio/x', `/repos/preflight?repo=yeyo11/claudio&ref=${'v'.repeat(141)}`]) {
    const answer = await call(s.deps, path, s.read);
    assert.equal(answer.status, 400, path);
    assert.equal(answer.body.error?.code, 'invalid_input');
  }
  assert.deepEqual(s.asked, []);
});

test('GitHub’s failures answer with a status: a repo it does not show is a 404, anything else a 502', async () => {
  const missing = await setup({ failing: 404 });
  const notFound = await call(missing.deps, '/repos/releases?repo=yeyo11/nothing', missing.read);
  assert.equal(notFound.status, 404);
  assert.match(notFound.body.error?.message ?? '', /GitHub has no repo yeyo11\/nothing/);

  const limited = await setup({ failing: 403 });
  for (const path of ['/repos', '/repos/releases?repo=yeyo11/claudio', '/repos/preflight?repo=yeyo11/claudio']) {
    const answer = await call(limited.deps, path, limited.read);
    assert.equal(answer.status, 502, path);
    assert.equal(answer.body.error?.code, 'upstream');
  }
});

test('without the repos service the routes refuse, and the OpenAPI document describes them', async () => {
  const s = await setup({ withoutRepos: true });
  assert.equal((await call(s.deps, '/repos', s.read)).status, 409);
  assert.equal((await call(s.deps, '/repos/releases?repo=yeyo11/claudio', s.read)).status, 409);

  const doc = openApiDocument('https://shipcast.example', s.deps) as { paths: Record<string, Record<string, { operationId: string; parameters?: Array<{ name: string }> }>> };
  assert.equal(doc.paths['/repos']?.get?.operationId, 'listRepos');
  assert.equal(doc.paths['/repos/releases']?.get?.operationId, 'listReleases');
  assert.deepEqual(doc.paths['/repos/preflight']?.get?.parameters?.map((p) => p.name), ['repo', 'ref']);
});
