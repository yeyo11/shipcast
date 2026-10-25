import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ArticleInput, Launch, Registry, ReviewGitHub } from '@shipcast/engine';
import { memoryRegistry } from '@shipcast/engine/testing';
import { createApiToken, MemoryStore } from '@shipcast/runtime';
import { FailureLimiter, handleApi, openApiDocument, PEER_HEADER, ROUTES, type ApiDeps } from '../src/server/api.ts';

const github: ReviewGitHub = {
  pullRequest: async (_repo, number) => ({ number, url: `https://github.com/yeyo11/launches/pull/${number}`, state: 'open', branch: 'launch/x', title: 'x' }),
  pullRequestFiles: async () => ['launches/claudio/v1/bluesky.md', 'src/content/posts/en/claudio.md'],
  fileAt: async () => 'text',
  updateFile: async () => {},
  mergePullRequest: async () => ({ sha: 'abc' }),
};

interface Setup {
  deps: ApiDeps;
  registry: Registry;
  calls: string[];
  read: string;
  write: string;
  both: string;
}

async function setup(): Promise<Setup> {
  const registry = await memoryRegistry();
  const secrets = new MemoryStore();
  const calls: string[] = [];
  const deps: ApiDeps = {
    registry,
    secrets,
    github,
    launchesRepo: 'yeyo11/launches',
    publicUrl: 'https://shipcast.example',
    limiter: new FailureLimiter(3, 60_000),
    jobs: async () => [{ id: 'j1', title: 'Drafting', state: 'running', log: [], link: null, startedAt: '2026-10-25T00:00:00.000Z' }],
    startLaunch: async (repo, ref, direct) => {
      calls.push(`launch ${repo} ${ref ?? '-'} ${direct}`);
      return repo === 'yeyo11/old' ? { ok: false, problem: 'launched already' } : { ok: true, job: 'j2' };
    },
    approve: async (id) => {
      calls.push(`approve ${id}`);
      return { ok: true, job: 'j3' };
    },
    startArticle: async (input: ArticleInput, direct) => {
      calls.push(`article ${input.title} ${input.lang} ${input.channels.join(',')} ${direct}`);
      return { ok: true, job: 'j4' };
    },
    startPublishing: async (launch: Launch) => {
      calls.push(`publish ${launch.id} ${launch.status}`);
      return 'j5';
    },
  };
  const tokens = { registry, secrets };
  return {
    deps,
    registry,
    calls,
    read: (await createApiToken(tokens, 'reader', ['read'])).token,
    write: (await createApiToken(tokens, 'writer', ['write'])).token,
    both: (await createApiToken(tokens, 'mcp', ['read', 'write'])).token,
  };
}

function call(deps: ApiDeps, method: string, path: string, options: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...options.headers };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  return handleApi(
    new Request(`https://shipcast.example/api/v1${path}`, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) }),
    deps,
  );
}

const body = async (response: Response) => (await response.json()) as Record<string, unknown>;

test('no token, a wrong one, a cookie or a revoked one is a 401', async () => {
  const s = await setup();
  const none = await call(s.deps, 'GET', '/launches');
  assert.equal(none.status, 401);
  assert.match(none.headers.get('www-authenticate') ?? '', /^Bearer/);
  assert.deepEqual(Object.keys(await body(none)), ['error']);

  const cookie = await call(s.deps, 'GET', '/launches', { headers: { cookie: 'sc_session=anything' } });
  assert.equal(cookie.status, 401, 'the session cookie does not open the API');
  assert.match(JSON.stringify(await body(cookie)), /not the session cookie/);

  assert.equal((await call(s.deps, 'GET', '/launches', { token: 'shipcast_1_nope' })).status, 401);

  const [first] = await s.registry.apiTokens();
  await s.registry.revokeApiToken(first!.id);
  const revoked = await call(s.deps, 'GET', '/launches', { token: s.both });
  assert.equal(revoked.status, 401);
  assert.match(JSON.stringify(await body(revoked)), /revoked/);
});

test('wrong tokens from one client are limited; other clients are not', async () => {
  const s = await setup();
  const from = (peer: string, token: string) => call(s.deps, 'GET', '/jobs', { token, headers: { [PEER_HEADER]: peer } });
  for (let i = 0; i < 3; i++) assert.equal((await from('10.0.0.1', 'shipcast_9_wrong')).status, 401);
  const limited = await from('10.0.0.1', s.read);
  assert.equal(limited.status, 429, 'even a good token waits once the client is limited');
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  assert.equal((await from('10.0.0.2', s.read)).status, 200);
});

test('each route needs its scope', async () => {
  const s = await setup();
  const readOnWrite = await call(s.deps, 'POST', '/launches', { token: s.read, body: { repo: 'yeyo11/claudio' } });
  assert.equal(readOnWrite.status, 403);
  assert.match(readOnWrite.headers.get('www-authenticate') ?? '', /insufficient_scope.*scope="write"/);
  assert.equal((await call(s.deps, 'GET', '/launches', { token: s.write })).status, 403, 'write does not include read');
  assert.equal((await call(s.deps, 'GET', '/launches', { token: s.read })).status, 200);
  assert.equal((await call(s.deps, 'POST', '/launches', { token: s.write, body: { repo: 'yeyo11/claudio' } })).status, 202);
  assert.deepEqual(s.calls, ['launch yeyo11/claudio - false']);
});

test('launches are paged by cursor and filtered by status', async () => {
  const s = await setup();
  for (let i = 1; i <= 5; i++) {
    const { launch } = await s.registry.claim({ repo: 'yeyo11/claudio', ref: `v0.${i}.0`, trigger: 'release', kind: 'launch', brand: 'personal' });
    if (i % 2 === 0) await s.registry.setStatus(launch.id, 'published');
  }
  const first = await body(await call(s.deps, 'GET', '/launches?limit=2', { token: s.read }));
  const refs = (page: Record<string, unknown>) => (page.launches as Array<{ ref: string }>).map((l) => l.ref);
  assert.deepEqual(refs(first), ['v0.5.0', 'v0.4.0']);
  assert.equal(typeof first.next, 'string');
  const second = await body(await call(s.deps, 'GET', `/launches?limit=2&cursor=${first.next as string}`, { token: s.read }));
  assert.deepEqual(refs(second), ['v0.3.0', 'v0.2.0']);
  const last = await body(await call(s.deps, 'GET', `/launches?limit=2&cursor=${second.next as string}`, { token: s.read }));
  assert.deepEqual(refs(last), ['v0.1.0']);
  assert.equal(last.next, null);

  const published = await body(await call(s.deps, 'GET', '/launches?status=published', { token: s.read }));
  assert.deepEqual(refs(published), ['v0.4.0', 'v0.2.0']);

  for (const bad of ['?limit=0', '?limit=101', '?limit=x', '?status=gone', '?cursor=bad']) {
    const response = await call(s.deps, 'GET', `/launches${bad}`, { token: s.read });
    assert.equal(response.status, 400, bad);
    assert.equal(((await body(response)).error as { code: string }).code, 'invalid_input');
  }
});

test('a launch comes with its posts, numbers, index status and drafts summary', async () => {
  const s = await setup();
  const { launch } = await s.registry.claim({ repo: 'yeyo11/claudio', ref: 'v1.0.0', trigger: 'release', kind: 'launch', brand: 'personal' });
  await s.registry.setStatus(launch.id, 'drafted', 'Drafts: https://github.com/yeyo11/launches/pull/7');
  await s.registry.recordPost({ launchId: launch.id, channel: 'blog', kind: 'article:en', externalId: null, url: 'https://josegarrido.dev/en/blog/claudio' });
  await s.registry.recordMetrics(launch.id, 'blog', { views: 12 }, new Date('2026-10-25T00:00:00Z'));

  const response = await call(s.deps, 'GET', `/launches/${launch.id}`, { token: s.read });
  assert.equal(response.status, 200);
  const detail = await body(response);
  assert.equal(detail.repo, 'yeyo11/claudio');
  assert.equal((detail.posts as unknown[]).length, 1);
  assert.deepEqual(detail.metrics, [{ source: 'blog', name: 'views', value: 12, takenAt: '2026-10-25T00:00:00.000Z' }]);
  assert.deepEqual(
    (detail.index as Array<{ engine: string; indexed: unknown }>).map((i) => [i.engine, i.indexed]),
    [['google', null]],
  );
  const drafts = detail.drafts as { count: number; pullRequest: { number: number }; files: Array<Record<string, unknown>> };
  assert.equal(drafts.pullRequest.number, 7);
  assert.equal(drafts.count, 2);
  assert.ok(drafts.files.every((f) => !('content' in f)), 'the drafts are listed, their text stays in the pull request');

  assert.equal((await call(s.deps, 'GET', '/launches/999', { token: s.read })).status, 404);
  assert.equal((await call(s.deps, 'GET', '/launches/abc', { token: s.read })).status, 400);
});

test('accounts come without secrets, and jobs as the app lists them', async () => {
  const s = await setup();
  await s.registry.addAccount({ network: 'devto', brand: 'personal', label: 'me', settings: { handle: 'me' } });
  await s.deps.secrets.set('account:1', '{"apiKey":"secret"}', 'x');
  const accounts = await call(s.deps, 'GET', '/accounts', { token: s.read });
  const text = await accounts.text();
  assert.equal(accounts.status, 200);
  assert.match(text, /"network":"devto"/);
  assert.doesNotMatch(text, /secret/);
  assert.deepEqual(((await body(await call(s.deps, 'GET', '/jobs', { token: s.read }))).jobs as Array<{ id: string }>).map((j) => j.id), ['j1']);
});

test('the writes start the same work the pages do, with their checks', async () => {
  const s = await setup();
  const { launch } = await s.registry.claim({ repo: 'yeyo11/claudio', ref: 'v1.0.0', trigger: 'release', kind: 'launch', brand: 'personal' });
  await s.registry.setStatus(launch.id, 'published');
  await s.registry.setCursor(`publish-failed:${launch.id}:devto`, 'rejected');

  const accepted = await call(s.deps, 'POST', '/launches', { token: s.write, body: { repo: 'yeyo11/claudio', ref: 'v2.0.0', direct: true } });
  assert.equal(accepted.status, 202);
  assert.deepEqual(await body(accepted), { job: 'j2' });
  const refusal = await call(s.deps, 'POST', '/launches', { token: s.write, body: { repo: 'yeyo11/old' } });
  assert.equal(refusal.status, 409);
  assert.equal(((await body(refusal)).error as { message: string }).message, 'launched already');
  assert.equal((await call(s.deps, 'POST', '/launches', { token: s.write, body: { repo: 'not a repo' } })).status, 400);
  const notJson = await handleApi(
    new Request('https://shipcast.example/api/v1/launches', { method: 'POST', headers: { authorization: `Bearer ${s.write}`, 'content-type': 'text/plain' }, body: 'repo=x' }),
    s.deps,
  );
  assert.equal(notJson.status, 415);

  assert.equal((await call(s.deps, 'POST', `/launches/${launch.id}/approve`, { token: s.write })).status, 202);
  assert.equal((await call(s.deps, 'POST', '/launches/999/approve', { token: s.write })).status, 404);

  assert.equal((await call(s.deps, 'POST', `/launches/${launch.id}/retry/nowhere`, { token: s.write })).status, 400);
  const retry = await call(s.deps, 'POST', `/launches/${launch.id}/retry/devto`, { token: s.write });
  assert.equal(retry.status, 202);
  assert.equal(await s.registry.cursor(`publish-failed:${launch.id}:devto`), undefined, 'the failure is forgotten');
  assert.equal((await s.registry.get(launch.id))?.status, 'drafted');

  const article = await call(s.deps, 'POST', '/articles', { token: s.write, body: { title: ' Hello ', markdown: 'Body', lang: 'en', channels: ['devto', 'nowhere'] } });
  assert.equal(article.status, 202);
  assert.equal((await call(s.deps, 'POST', '/articles', { token: s.write, body: { title: 'x', markdown: 'y', lang: 'fr' } })).status, 400);

  assert.deepEqual(s.calls, ['launch yeyo11/claudio v2.0.0 true', 'launch yeyo11/old - false', `approve ${launch.id}`, `publish ${launch.id} drafted`, 'article Hello en devto false']);
});

test('unknown routes and methods say so', async () => {
  const s = await setup();
  assert.equal((await call(s.deps, 'GET', '/nowhere', { token: s.both })).status, 404);
  const wrongMethod = await call(s.deps, 'DELETE', '/launches', { token: s.both });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('allow'), 'GET, POST');
});

test('the OpenAPI document is public and lists every route with its scope', async () => {
  const s = await setup();
  const response = await call(s.deps, 'GET', '/openapi.json');
  assert.equal(response.status, 200);
  const doc = (await response.json()) as ReturnType<typeof openApiDocument>;
  assert.equal(doc.openapi, '3.1.0');
  assert.equal(doc.servers[0]?.url, 'https://shipcast.example/api/v1');
  for (const route of ROUTES) {
    const operation = doc.paths[route.path]?.[route.method.toLowerCase()] as { security: Array<{ bearer: string[] }>; operationId: string } | undefined;
    assert.ok(operation, `${route.method} ${route.path}`);
    assert.deepEqual(operation.security, [{ bearer: [route.scope] }]);
  }
  assert.equal(new Set(ROUTES.map((r) => r.operationId)).size, ROUTES.length);
});
