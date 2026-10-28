import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConnectorError } from '@shipcast/connectors';
import type { ArticleInput, Editors, Launch, Registry, ReviewGitHub } from '@shipcast/engine';
import { memoryRegistry } from '@shipcast/engine/testing';
import { WEBMCP_HEADER } from '@shipcast/mcp/webmcp';
import { createApiToken, MemoryStore, writeWebMcp } from '@shipcast/runtime';
import { checkBearer, FailureLimiter, handleApi, openApiDocument, PEER_HEADER, ROUTES, type ApiDeps } from '../src/server/api.ts';
import { jobsFeed } from '../src/server/jobs.server.ts';
import { createSession, SESSION_COOKIE } from '../src/server/session.server.ts';

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
  /** What the fake connectors were asked to edit or delete */
  sent: string[];
  read: string;
  write: string;
  both: string;
}

async function setup(): Promise<Setup> {
  const registry = await memoryRegistry();
  const secrets = new MemoryStore();
  const calls: string[] = [];
  const sent: string[] = [];
  const fake = (channel: string) => ({
    edit: async (id: string, input: unknown) => {
      if (id === 'refused') throw new ConnectorError('Mastodon', 'edit: 422 Text is too long', 422);
      sent.push(`edit ${channel} ${id} ${JSON.stringify(input)}`);
    },
    delete: async (id: string) => {
      sent.push(`delete ${channel} ${id}`);
    },
  });
  const deps: ApiDeps = {
    registry,
    secrets,
    github,
    launchesRepo: 'yeyo11/launches',
    publicUrl: 'https://shipcast.example',
    limiter: new FailureLimiter(3, 60_000),
    jobs: (page) => jobsFeed(registry, page),
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
    editing: async () => ({
      registry,
      editors: async (channel) => ({ [channel]: channel === 'bluesky' ? { delete: fake('bluesky').delete } : fake(channel) }) as Editors,
    }),
    armSchedule: async (posts) => {
      for (const p of posts) calls.push(`arm ${p.id} ${p.scheduledAt}`);
    },
    comments: async () => ({
      registry,
      connectors: async (channel) =>
        channel === 'mastodon'
          ? {
              replier: {
                reply: async (target, text) => {
                  if (text === 'refused') throw new ConnectorError('Mastodon', 'reply: 422 Validation failed', 422);
                  sent.push(`reply ${channel} ${target.commentExternalId} ${text}`);
                  return { externalId: 'r1', url: 'https://mastodon.example/r1' };
                },
              },
            }
          : {},
    }),
    checkComments: async () => {
      calls.push('check comments');
      return { ok: true, job: 'j6' };
    },
    redraftComment: async (id) => {
      calls.push(`redraft ${id}`);
      return (await registry.comments.comment(id)) ? { ok: true, job: 'j7' } : { ok: false, problem: 'no such comment' };
    },
  };
  const tokens = { registry, secrets };
  return {
    deps,
    registry,
    calls,
    sent,
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
    const { launch } = await s.registry.launches.claim({ repo: 'yeyo11/claudio', ref: `v0.${i}.0`, trigger: 'release', kind: 'launch', brand: 'personal' });
    if (i % 2 === 0) await s.registry.launches.setStatus(launch.id, 'published');
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

test('launches are searched, filtered and sorted, and a cursor keeps its sort', async () => {
  const s = await setup();
  const claim = (repo: string, ref: string, trigger: 'release' | 'manual' | 'article' = 'release', kind: 'launch' | 'minor' = 'minor') =>
    s.registry.launches.claim({ repo, ref, trigger, kind, brand: 'personal' });
  await claim('yeyo11/claudio', 'v1.0.0', 'release', 'launch');
  await claim('yeyo11/claudio', 'v1.1.0', 'manual');
  await claim('yeyo11/shipcast', 'v0.1.0');
  await claim('yeyo11/launches', 'article:hello-world', 'article', 'launch');
  const refs = async (query: string) => ((await body(await call(s.deps, 'GET', `/launches${query}`, { token: s.read }))).launches as Array<{ ref: string }>).map((l) => l.ref);

  assert.deepEqual(await refs('?repo=yeyo11/claudio'), ['v1.1.0', 'v1.0.0']);
  assert.deepEqual(await refs('?trigger=manual'), ['v1.1.0']);
  assert.deepEqual(await refs('?kind=launch'), ['article:hello-world', 'v1.0.0']);
  assert.deepEqual(await refs(`?q=${encodeURIComponent('Hello World')}`), ['article:hello-world']);
  assert.deepEqual(await refs('?q=SHIP'), ['v0.1.0']);
  assert.deepEqual(await refs('?sort=oldest&limit=2'), ['v1.0.0', 'v1.1.0']);

  const first = await body(await call(s.deps, 'GET', '/launches?sort=oldest&limit=3', { token: s.read }));
  const rest = await refs(`?sort=oldest&limit=3&cursor=${first.next as string}`);
  assert.deepEqual(rest, ['article:hello-world']);
  const mixed = await call(s.deps, 'GET', `/launches?limit=3&cursor=${first.next as string}`, { token: s.read });
  assert.equal(mixed.status, 400, "an oldest-first cursor does not walk the newest-first order");

  for (const bad of ['?trigger=cron', '?kind=patch', '?sort=views', '?repo=not-a-repo', `?q=${'x'.repeat(201)}`]) {
    const response = await call(s.deps, 'GET', `/launches${bad}`, { token: s.read });
    assert.equal(response.status, 400, bad);
  }
});

test('a launch comes with its posts, numbers, index status and drafts summary', async () => {
  const s = await setup();
  const { launch } = await s.registry.launches.claim({ repo: 'yeyo11/claudio', ref: 'v1.0.0', trigger: 'release', kind: 'launch', brand: 'personal' });
  await s.registry.launches.setStatus(launch.id, 'drafted', 'Drafts: https://github.com/yeyo11/launches/pull/7');
  await s.registry.posts.recordPost({ launchId: launch.id, channel: 'blog', kind: 'article:en', externalId: null, url: 'https://josegarrido.dev/en/blog/claudio' });
  await s.registry.metrics.recordMetrics(launch.id, 'blog', { views: 12 }, new Date('2026-10-25T00:00:00Z'));

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
  await s.registry.accounts.addAccount({ network: 'devto', brand: 'personal', label: 'me', settings: { handle: 'me' } });
  await s.deps.secrets.set('account:1', '{"apiKey":"secret"}', 'x');
  const accounts = await call(s.deps, 'GET', '/accounts', { token: s.read });
  const text = await accounts.text();
  assert.equal(accounts.status, 200);
  assert.match(text, /"network":"devto"/);
  assert.doesNotMatch(text, /secret/);
  await s.registry.jobs.recordJob({ id: 'j1', queue: 'draft', title: 'Drafting' });
  assert.deepEqual(((await body(await call(s.deps, 'GET', '/jobs', { token: s.read }))).jobs as Array<{ id: string }>).map((j) => j.id), ['j1']);
});

test('jobs come a page at a time, and the cursor walks the whole day', async () => {
  const s = await setup();
  // Recorded in order, so newest first is j5..j1 whether or not two share a millisecond
  for (let i = 1; i <= 5; i++) await s.registry.jobs.recordJob({ id: `j${i}`, queue: 'draft', title: `Drafting ${i}` });
  // A round that ended well is not listed: Automation shows the last one
  await s.registry.jobs.recordJob({ id: 'r1', queue: 'round', title: 'Round' });
  await s.registry.jobs.updateJob('r1', { state: 'completed', ended: true });
  const seen: string[] = [];
  let cursor: string | null = null;
  for (let pages = 0; pages < 5; pages++) {
    const page: Record<string, unknown> = await body(await call(s.deps, 'GET', `/jobs?limit=2${cursor ? `&cursor=${cursor}` : ''}`, { token: s.read }));
    seen.push(...(page.jobs as Array<{ id: string }>).map((j) => j.id));
    cursor = page.next as string | null;
    if (cursor === null) break;
  }
  assert.deepEqual(seen, ['j5', 'j4', 'j3', 'j2', 'j1']);
  assert.equal((await call(s.deps, 'GET', '/jobs?limit=0', { token: s.read })).status, 400);
  assert.equal((await call(s.deps, 'GET', '/jobs?cursor=nope', { token: s.read })).status, 400);
  // A launches' cursor (a numeric id) is not a jobs' one
  const launchCursor = Buffer.from(JSON.stringify(['2026-10-25T00:00:00.000Z', 3])).toString('base64url');
  assert.equal((await call(s.deps, 'GET', `/jobs?cursor=${launchCursor}`, { token: s.read })).status, 400);
});

test('the writes start the same work the pages do, with their checks', async () => {
  const s = await setup();
  const { launch } = await s.registry.launches.claim({ repo: 'yeyo11/claudio', ref: 'v1.0.0', trigger: 'release', kind: 'launch', brand: 'personal' });
  await s.registry.launches.setStatus(launch.id, 'published');
  await s.registry.cursors.setCursor(`publish-failed:${launch.id}:devto`, 'rejected');

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
  assert.equal(await s.registry.cursors.cursor(`publish-failed:${launch.id}:devto`), undefined, 'the failure is forgotten');
  assert.equal((await s.registry.launches.get(launch.id))?.status, 'drafted');

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

async function publishedLaunch(registry: Registry) {
  const { launch } = await registry.launches.claim({ repo: 'yeyo11/claudio', ref: 'v2.0.0', trigger: 'release', kind: 'launch', brand: 'personal' });
  await registry.launches.setStatus(launch.id, 'published');
  const record = async (channel: 'mastodon' | 'bluesky' | 'telegram', externalId: string) =>
    (await registry.posts.recordPost({ launchId: launch.id, channel, externalId, url: `https://${channel}.example/${externalId}` })).post;
  return { launch, mastodon: await record('mastodon', '111'), bluesky: await record('bluesky', 'at://did:plc:a/app.bsky.feed.post/1'), telegram: await record('telegram', '@c:5') };
}

test('a post is edited and deleted through the API with the write scope', async () => {
  const s = await setup();
  const { mastodon } = await publishedLaunch(s.registry);
  assert.equal((await call(s.deps, 'PATCH', `/posts/${mastodon.id}`, { token: s.read, body: { text: 'x' } })).status, 403);

  const edited = await call(s.deps, 'PATCH', `/posts/${mastodon.id}`, { token: s.write, body: { text: 'Fixed', link: 'https://site.dev/en/x/' } });
  assert.equal(edited.status, 200);
  assert.equal(((await body(edited)).post as { status: string }).status, 'edited');
  assert.deepEqual(s.sent, ['edit mastodon 111 {"text":"Fixed\\n\\nhttps://site.dev/en/x/"}']);

  const deleted = await call(s.deps, 'DELETE', `/posts/${mastodon.id}`, { token: s.write });
  assert.equal(((await body(deleted)).post as { status: string }).status, 'deleted');
  const again = await call(s.deps, 'DELETE', `/posts/${mastodon.id}`, { token: s.write });
  assert.equal(again.status, 409);
  assert.match(((await body(again)).error as { message: string }).message, /deleted already/);
});

test('what a network cannot do is a 409, a bad change a 400, a missing post a 404, the network refusing a 502', async () => {
  const s = await setup();
  const { bluesky, launch } = await publishedLaunch(s.registry);
  const noEdit = await call(s.deps, 'PATCH', `/posts/${bluesky.id}`, { token: s.write, body: { text: 'x' } });
  assert.equal(noEdit.status, 409);
  assert.match(((await body(noEdit)).error as { message: string }).message, /Bluesky cannot edit/);
  assert.equal((await call(s.deps, 'PATCH', `/posts/${bluesky.id}`, { token: s.write, body: {} })).status, 400);
  assert.equal((await call(s.deps, 'PATCH', `/posts/${bluesky.id}`, { token: s.write, body: { link: 'javascript:alert(1)' } })).status, 400);
  assert.equal((await call(s.deps, 'DELETE', '/posts/9999', { token: s.write })).status, 404);
  assert.equal((await call(s.deps, 'DELETE', '/posts/abc', { token: s.write })).status, 400);
  const refused = (await s.registry.posts.recordPost({ launchId: launch.id, channel: 'mastodon', kind: 'post', accountId: (await s.registry.accounts.addAccount({ network: 'mastodon', brand: 'personal', label: '@b', settings: {} })).id, externalId: 'refused', url: null })).post;
  const upstream = await call(s.deps, 'PATCH', `/posts/${refused.id}`, { token: s.write, body: { text: 'x'.repeat(600) } });
  assert.equal(upstream.status, 502);
  assert.match(((await body(upstream)).error as { message: string }).message, /Text is too long/);
  assert.equal((await s.registry.posts.post(refused.id))!.status, 'live');
});

test('a launch’s posts are edited and deleted at once, per channel, with what each one did', async () => {
  const s = await setup();
  const { launch, telegram } = await publishedLaunch(s.registry);
  const edited = await call(s.deps, 'PATCH', `/launches/${launch.id}/posts`, { token: s.write, body: { text: 'Shared', channels: ['mastodon', 'bluesky'] } });
  assert.equal(edited.status, 200);
  assert.deepEqual(
    ((await body(edited)).outcomes as Array<{ channel: string; ok: boolean; reason?: string }>).map((o) => `${o.channel} ${o.ok ? 'ok' : o.reason}`),
    ['mastodon ok', 'bluesky unsupported'],
  );
  assert.equal((await call(s.deps, 'PATCH', `/launches/${launch.id}/posts`, { token: s.write, body: { text: 'x', channels: ['nope'] } })).status, 400);

  const deleted = await call(s.deps, 'DELETE', `/launches/${launch.id}/posts?channels=bluesky,mastodon`, { token: s.write });
  assert.deepEqual(((await body(deleted)).outcomes as Array<{ ok: boolean }>).map((o) => o.ok), [true, true]);
  assert.equal((await s.registry.posts.post(telegram.id))!.status, 'live', 'a channel not named is left alone');
  assert.equal((await call(s.deps, 'DELETE', '/launches/999/posts', { token: s.write })).status, 404);
});

test('the capability map is readable with the read scope', async () => {
  const s = await setup();
  const response = await call(s.deps, 'GET', '/capabilities', { token: s.read });
  const capabilities = (await body(response)).capabilities as Record<string, { edit: string; delete: string }>;
  assert.deepEqual(capabilities.bluesky && [capabilities.bluesky.edit, capabilities.bluesky.delete], ['no', 'yes']);
  assert.equal(capabilities.devto?.delete, 'unpublish');
});

test('a launch’s channels are scheduled, moved and cancelled through the API', async () => {
  const s = await setup();
  const { launch } = await s.registry.launches.claim({ repo: 'yeyo11/claudio', ref: 'v3.0.0', trigger: 'release', kind: 'launch', brand: 'personal' });
  await s.registry.launches.setStatus(launch.id, 'drafted', 'https://github.com/yeyo11/launches/pull/9');

  const refusedScope = await call(s.deps, 'POST', `/launches/${launch.id}/schedule`, { token: s.read, body: { times: { bluesky: '2030-01-01T10:00:00Z' } } });
  assert.equal(refusedScope.status, 403);
  const noOffset = await call(s.deps, 'POST', `/launches/${launch.id}/schedule`, { token: s.write, body: { times: { bluesky: '2030-01-01T10:00:00' } } });
  assert.equal(noOffset.status, 400, 'a time without its offset is nobody’s time');
  const reddit = await call(s.deps, 'POST', `/launches/${launch.id}/schedule`, { token: s.write, body: { times: { reddit: '2030-01-01T10:00:00Z' } } });
  assert.equal(reddit.status, 400, 'Reddit is always a draft');

  const at = new Date(Date.now() + 3 * 86_400_000);
  at.setUTCMinutes(0, 0, 0);
  const scheduled = await call(s.deps, 'POST', `/launches/${launch.id}/schedule`, { token: s.write, body: { times: { bluesky: at.toISOString(), mastodon: at.toISOString().replace('Z', '+00:00') } } });
  assert.equal(scheduled.status, 200);
  const posts = (await body(scheduled)).posts as Array<{ id: number; channel: string; status: string; scheduledAt: string }>;
  assert.deepEqual(posts.map((p) => [p.channel, p.status, p.scheduledAt]), [['bluesky', 'scheduled', at.toISOString()], ['mastodon', 'scheduled', at.toISOString()]]);
  assert.deepEqual(s.calls.filter((c) => c.startsWith('arm')).length, 2, 'each one’s wake-up is queued');

  const later = new Date(at.getTime() + 3600_000).toISOString();
  const moved = await call(s.deps, 'PATCH', `/posts/${posts[0]!.id}/schedule`, { token: s.write, body: { at: later } });
  assert.equal(moved.status, 200);
  assert.equal(((await body(moved)).post as { scheduledAt: string }).scheduledAt, later);
  assert.ok(s.calls.includes(`arm ${posts[0]!.id} ${later}`), 'and moved with it');

  const edit = await call(s.deps, 'PATCH', `/posts/${posts[0]!.id}`, { token: s.write, body: { text: 'x' } });
  assert.equal(edit.status, 409, 'a scheduled piece is not on the network yet: its schedule is what changes');

  const cancelled = await call(s.deps, 'DELETE', `/posts/${posts[1]!.id}/schedule`, { token: s.write });
  assert.equal(cancelled.status, 200);
  assert.equal((await call(s.deps, 'DELETE', `/posts/${posts[1]!.id}/schedule`, { token: s.write })).status, 404, 'gone');
  assert.deepEqual((await s.registry.posts.posts(launch.id)).map((p) => p.channel), ['bluesky']);
});

test('recommendations and the time zone are read with the read scope, the zone set with write', async () => {
  const s = await setup();
  const zone = await call(s.deps, 'GET', '/settings/timezone', { token: s.read });
  assert.deepEqual(await body(zone), { timezone: 'Europe/Madrid' });
  assert.equal((await call(s.deps, 'PATCH', '/settings/timezone', { token: s.write, body: { timezone: '+01:00' } })).status, 400, 'an offset has no summer time');
  assert.equal((await call(s.deps, 'PATCH', '/settings/timezone', { token: s.write, body: { timezone: 'Mars/Olympus' } })).status, 400);
  const saved = await call(s.deps, 'PATCH', '/settings/timezone', { token: s.write, body: { timezone: 'America/New_York' } });
  assert.deepEqual(await body(saved), { timezone: 'America/New_York' });

  assert.equal((await call(s.deps, 'GET', '/recommendations?channel=reddit', { token: s.read })).status, 400);
  const rec = await call(s.deps, 'GET', '/recommendations?channel=bluesky&count=3', { token: s.read });
  assert.equal(rec.status, 200);
  const answer = await body(rec);
  assert.equal(answer.timezone, 'America/New_York');
  const slots = answer.slots as Array<{ at: string; reason: string; basis: string }>;
  assert.equal(slots.length, 3);
  assert.ok(slots.every((slot) => slot.basis === 'default' && slot.reason.length > 0), 'no history yet: the defaults speak');
});

test('WebMCP: the session cookie opens the API only same-origin, with the header, and while the setting is on', async () => {
  const s = await setup();
  const session = `${SESSION_COOKIE}=${encodeURIComponent((await createSession(s.deps.secrets, 'yeyo11')).value)}`;
  const webmcp = (headers: Record<string, string>) => call(s.deps, 'POST', '/launches', { body: { repo: 'yeyo11/claudio' }, headers });
  const browser = { cookie: session, [WEBMCP_HEADER]: '1', 'sec-fetch-site': 'same-origin' };

  const off = await webmcp(browser);
  assert.equal(off.status, 401, 'off by default');
  assert.match(JSON.stringify(await body(off)), /WebMCP is off/);

  await writeWebMcp(s.registry, true);
  assert.equal((await webmcp(browser)).status, 202, 'the owner’s session may read and write');
  assert.equal((await call(s.deps, 'GET', '/launches', { headers: browser })).status, 200);

  assert.equal((await webmcp({ ...browser, 'sec-fetch-site': 'cross-site' })).status, 401, 'a page on another site');
  assert.equal((await webmcp({ cookie: session, 'sec-fetch-site': 'same-origin' })).status, 401, 'the app’s own pages without the header');
  assert.equal((await webmcp({ ...browser, cookie: `${SESSION_COOKIE}=forged.sig` })).status, 401, 'a forged session');
  assert.equal((await webmcp({ ...browser, authorization: `Bearer ${s.read}` })).status, 403, 'a token, when sent, is what counts');
  assert.deepEqual(s.calls, ['launch yeyo11/claudio - false']);
});

test('the MCP endpoint’s bearer check: the API’s refusals, and the same limit on wrong tokens', async () => {
  const s = await setup();
  const at = (token: string | undefined, peer = '10.0.0.9') =>
    checkBearer(new Request('https://shipcast.example/mcp', { method: 'POST', headers: { [PEER_HEADER]: peer, ...(token && { authorization: `Bearer ${token}` }) } }), s.deps);
  assert.equal(await at(s.both), undefined);
  assert.equal(await at(s.read), undefined, 'scopes are checked per tool, by the API');
  assert.equal((await at(undefined))?.status, 401);
  for (let i = 0; i < 3; i++) assert.equal((await at('shipcast_9_wrong'))?.status, 401);
  assert.equal((await at(s.both))?.status, 429);
  assert.equal((await call(s.deps, 'GET', '/jobs', { token: s.both, headers: { [PEER_HEADER]: '10.0.0.9' } })).status, 429, 'one limit for both doors');
});

async function commented(registry: Registry) {
  const { launch, mastodon } = await publishedLaunch(registry);
  const { post: devto } = await registry.posts.recordPost({ launchId: launch.id, channel: 'devto', externalId: '42', url: 'https://dev.to/me/x' });
  const add = async (postId: number, channel: 'mastodon' | 'devto', externalId: string, own = false) =>
    (
      await registry.comments.recordComment({
        postId,
        channel,
        externalId,
        author: { handle: '@ana@fosstodon.org' },
        text: 'Does it run on Windows?',
        url: `https://${channel}.example/c/${externalId}`,
        createdAt: `2026-10-2${externalId.length}T10:00:00.000Z`,
        own,
      })
    ).comment;
  return { launch, question: await add(mastodon.id, 'mastodon', '201'), other: await add(mastodon.id, 'mastodon', '2022'), own: await add(mastodon.id, 'mastodon', '20333', true), devto: await add(devto.id, 'devto', 'a1') };
}

test('comments are listed with the read scope, filtered, the owner’s own left out, and dev.to’s with where to answer', async () => {
  const s = await setup();
  const { launch } = await commented(s.registry);
  const all = await call(s.deps, 'GET', '/comments', { token: s.read });
  assert.equal(all.status, 200);
  const listed = (await body(all)).comments as Array<{ externalId: string; canReply: boolean; replyOn?: string }>;
  assert.deepEqual(listed.map((c) => c.externalId).sort(), ['201', '2022', 'a1']);
  assert.deepEqual(listed.find((c) => c.externalId === 'a1'), { ...listed.find((c) => c.externalId === 'a1'), canReply: false, replyOn: 'https://devto.example/c/a1' });
  const mastodon = await call(s.deps, 'GET', `/comments?channel=mastodon&status=new&launch=${launch.id}`, { token: s.read });
  assert.equal(((await body(mastodon)).comments as unknown[]).length, 2);
  assert.equal((await call(s.deps, 'GET', '/comments?status=nope', { token: s.read })).status, 400);
  assert.equal((await call(s.deps, 'GET', '/comments?channel=telegram', { token: s.read })).status, 400);
  assert.equal((await call(s.deps, 'POST', '/comments/check', { token: s.read })).status, 403, 'checking is a write');
});

test('a reply is edited, approved and sent with the write scope; what cannot be done is a 409, a bad draft a 400, a network refusal a 502', async () => {
  const s = await setup();
  const { question, other, own, devto } = await commented(s.registry);
  assert.equal((await call(s.deps, 'POST', `/comments/${question.id}/approve`, { token: s.write })).status, 400, 'no draft yet');

  const edited = await call(s.deps, 'PATCH', `/comments/${question.id}`, { token: s.write, body: { draft: 'Not yet: it is planned.' } });
  assert.equal(edited.status, 200);
  assert.equal(((await body(edited)).comment as { status: string }).status, 'draft-ready');
  assert.equal((await call(s.deps, 'PATCH', `/comments/${question.id}`, { token: s.write, body: { draft: 'x'.repeat(401) } })).status, 400, 'over Mastodon’s limit');

  const approved = await call(s.deps, 'POST', `/comments/${question.id}/approve`, { token: s.write });
  assert.equal(approved.status, 200);
  assert.deepEqual(s.sent, ['reply mastodon 201 Not yet: it is planned.']);
  assert.equal(((await body(approved)).comment as { sentUrl: string }).sentUrl, 'https://mastodon.example/r1');
  assert.equal((await call(s.deps, 'POST', `/comments/${question.id}/approve`, { token: s.write })).status, 409, 'sent once only');

  await call(s.deps, 'PATCH', `/comments/${other.id}`, { token: s.write, body: { draft: 'refused' } });
  assert.equal((await call(s.deps, 'POST', `/comments/${other.id}/approve`, { token: s.write })).status, 502);
  assert.equal((await s.registry.comments.comment(other.id))!.status, 'failed');

  await call(s.deps, 'PATCH', `/comments/${devto.id}`, { token: s.write, body: { draft: 'Thanks!' } });
  assert.equal((await call(s.deps, 'POST', `/comments/${devto.id}/approve`, { token: s.write })).status, 409, 'dev.to cannot reply');
  assert.equal((await call(s.deps, 'PATCH', `/comments/${own.id}`, { token: s.write, body: { draft: 'x' } })).status, 409, 'your own comment');

  const dismissed = await call(s.deps, 'POST', `/comments/${devto.id}/dismiss`, { token: s.write });
  assert.equal(((await body(dismissed)).comment as { status: string }).status, 'dismissed');
  assert.equal((await call(s.deps, 'POST', '/comments/999/dismiss', { token: s.write })).status, 404);
  assert.equal((await call(s.deps, 'POST', '/comments/abc/dismiss', { token: s.write })).status, 400);
});

test('checking and drafting again are jobs; the reply modes are read and set', async () => {
  const s = await setup();
  const { question } = await commented(s.registry);
  assert.deepEqual(await body(await call(s.deps, 'POST', '/comments/check', { token: s.write })), { job: 'j6' });
  const redraft = await call(s.deps, 'POST', `/comments/${question.id}/draft`, { token: s.write });
  assert.equal(redraft.status, 202);
  assert.equal((await call(s.deps, 'POST', '/comments/999/draft', { token: s.write })).status, 404);
  assert.deepEqual(s.calls, ['check comments', `redraft ${question.id}`, 'redraft 999']);

  const modes = await body(await call(s.deps, 'GET', '/comment-settings', { token: s.read }));
  assert.deepEqual(modes, { replies: { mastodon: 'approval', bluesky: 'approval', instagram: 'approval', devto: 'approval', threads: 'approval', githubDiscussions: 'approval' } });
  const set = await call(s.deps, 'PUT', '/comment-settings', { token: s.write, body: { replies: { bluesky: 'auto', devto: 'auto' } } });
  assert.deepEqual(((await body(set)).replies as Record<string, string>), { mastodon: 'approval', bluesky: 'auto', instagram: 'approval', devto: 'approval', threads: 'approval', githubDiscussions: 'approval' });
  assert.equal((await call(s.deps, 'PUT', '/comment-settings', { token: s.write, body: { replies: { mastodon: 'sometimes' } } })).status, 400);
});

/*
 * Characterisation of the error answers, before the four wrappers (onPosts, onSchedule, onComments,
 * onProfiles) and the API's own catch became one mapping: every refusal's status, code and message,
 * whichever engine area threw it, and the 500 that keeps an unforeseen error's words in the log.
 */
test('each kind of refusal answers its status with the same body, whichever area refused', async () => {
  const s = await setup();
  const { launch, bluesky, mastodon } = await publishedLaunch(s.registry);
  const { question, devto } = await commented(s.registry);
  const errorOf = async (response: Response) => ({ status: response.status, ...((await body(response)).error as object) });

  assert.deepEqual(await errorOf(await call(s.deps, 'DELETE', '/posts/9999', { token: s.write })), { status: 404, code: 'not_found', message: 'no such post' });
  assert.deepEqual(await errorOf(await call(s.deps, 'PATCH', `/posts/${bluesky.id}`, { token: s.write, body: { text: 'x' } })), {
    status: 409,
    code: 'refused',
    message: 'Bluesky cannot edit a published post: Bluesky has no edit: a post can only be deleted and posted again, which loses its likes and replies, so Shipcast never does that on its own',
  });
  assert.deepEqual(await errorOf(await call(s.deps, 'PATCH', `/posts/${mastodon.id}`, { token: s.write, body: { title: 'x' } })), {
    status: 400,
    code: 'invalid_input',
    message: 'Mastodon cannot change title; it takes text, link, image',
  });
  assert.deepEqual(await errorOf(await call(s.deps, 'DELETE', `/launches/999/posts`, { token: s.write })), { status: 404, code: 'not_found', message: 'no such launch' });

  assert.deepEqual(await errorOf(await call(s.deps, 'DELETE', '/posts/9999/schedule', { token: s.write })), { status: 404, code: 'not_found', message: 'no such post' });
  assert.deepEqual(await errorOf(await call(s.deps, 'DELETE', `/posts/${mastodon.id}/schedule`, { token: s.write })), {
    status: 409,
    code: 'refused',
    message: `post ${mastodon.id} is live, not scheduled`,
  });
  assert.deepEqual(await errorOf(await call(s.deps, 'PATCH', '/settings/timezone', { token: s.write, body: { timezone: 'Mars/Olympus' } })), {
    status: 400,
    code: 'invalid_input',
    message: 'timezone is an IANA zone such as Europe/Madrid',
  });

  assert.deepEqual(await errorOf(await call(s.deps, 'POST', '/comments/999/dismiss', { token: s.write })), { status: 404, code: 'not_found', message: 'no such comment' });
  const noDraft = await errorOf(await call(s.deps, 'POST', `/comments/${question.id}/approve`, { token: s.write }));
  assert.deepEqual({ ...noDraft, message: '' }, { status: 400, code: 'invalid_input', message: '' });
  await call(s.deps, 'PATCH', `/comments/${devto.id}`, { token: s.write, body: { draft: 'Thanks!' } });
  const cannot = await errorOf(await call(s.deps, 'POST', `/comments/${devto.id}/approve`, { token: s.write }));
  assert.deepEqual({ ...cannot, message: '' }, { status: 409, code: 'refused', message: '' });
  assert.deepEqual(await errorOf(await call(s.deps, 'PUT', '/comment-settings', { token: s.write, body: { replies: { telegram: 'auto' } } })), {
    status: 400,
    code: 'invalid_input',
    message: 'telegram has no comments to read (devto, bluesky, mastodon, instagram, githubDiscussions, threads)',
  });

  const broken: ApiDeps = { ...s.deps, editing: async () => { throw new Error('the keychain is locked'); } };
  assert.deepEqual(await errorOf(await call(broken, 'PATCH', `/posts/${mastodon.id}`, { token: s.write, body: { text: 'x' } })), {
    status: 500,
    code: 'internal',
    message: 'something went wrong; the details are in the app’s log',
  });
  assert.ok(launch.id > 0);
});
