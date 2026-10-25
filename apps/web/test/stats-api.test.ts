import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Registry, ReviewGitHub } from '@shipcast/engine';
import { memoryRegistry } from '@shipcast/engine/testing';
import { createApiToken, MemoryStore } from '@shipcast/runtime';
import { FailureLimiter, handleApi, openApiDocument, type ApiDeps } from '../src/server/api.ts';

const unused = async (): Promise<never> => {
  throw new Error('the stats routes start no work');
};

async function setup() {
  const registry = await memoryRegistry();
  const secrets = new MemoryStore();
  const deps: ApiDeps = {
    registry,
    secrets,
    github: {} as ReviewGitHub,
    launchesRepo: 'yeyo11/launches',
    publicUrl: 'https://shipcast.example',
    limiter: new FailureLimiter(),
    jobs: async () => [],
    startLaunch: unused,
    approve: unused,
    startArticle: unused,
    startPublishing: unused,
    editing: unused,
    armSchedule: unused,
    comments: unused,
    checkComments: unused,
    redraftComment: unused,
  };
  const tokens = { registry, secrets };
  return { deps, registry, read: (await createApiToken(tokens, 'reader', ['read'])).token, write: (await createApiToken(tokens, 'writer', ['write'])).token };
}

async function get(deps: ApiDeps, path: string, token: string) {
  const response = await handleApi(new Request(`https://shipcast.example/api/v1${path}`, { headers: { authorization: `Bearer ${token}` } }), deps);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> & { error?: { code: string; message: string } } };
}

async function seed(registry: Registry) {
  const account = await registry.addAccount({ network: 'bluesky', brand: 'personal', label: '@me.bsky.social', settings: {} });
  const { launch } = await registry.claim({ repo: 'yeyo11/claudio', ref: 'v1.0.0', trigger: 'release', kind: 'launch', brand: 'personal' });
  const { post } = await registry.recordPost({ launchId: launch.id, channel: 'bluesky', accountId: account.id, externalId: 'at://1', url: 'https://bsky.app/1' });
  await registry.recordMetrics(launch.id, 'bluesky', { likes: 2 }, new Date('2026-10-12T06:00:00Z'), post.id);
  await registry.recordMetrics(launch.id, 'bluesky', { likes: 9 }, new Date('2026-10-17T06:00:00Z'), post.id);
  await registry.recordSnapshot(account.id, { followers: 3 }, new Date('2026-10-16T04:00:00Z'));
  await registry.recordSnapshot(account.id, { followers: 5 }, new Date('2026-10-17T04:00:00Z'));
  return { account, launch, post };
}

test('the stats routes answer with the read scope only', async () => {
  const s = await setup();
  await seed(s.registry);
  for (const path of ['/stats/overview', '/stats/series?metric=views', '/stats/ranking']) {
    assert.equal((await get(s.deps, path, s.write)).status, 403, path);
    assert.equal((await get(s.deps, path, s.read)).status, 200, path);
  }
});

test('the overview compares periods and the series and ranking take their parameters', async () => {
  const s = await setup();
  const { account, launch, post } = await seed(s.registry);

  const overview = await get(s.deps, '/stats/overview?from=2026-10-15&to=2026-10-19&compare=previous&channels=bluesky', s.read);
  assert.equal(overview.status, 200);
  const channels = overview.body.channels as Array<{ channel: string; metrics: { reactions: number }; previous: { reactions: number } }>;
  assert.deepEqual(channels.map((c) => [c.channel, c.metrics.reactions, c.previous.reactions]), [['bluesky', 7, 2]]);

  const custom = await get(s.deps, '/stats/overview?from=2026-10-15&to=2026-10-19&compareFrom=2026-10-01&compareTo=2026-10-14', s.read);
  assert.deepEqual(custom.body.compareTo, { from: '2026-10-01T00:00:00.000Z', to: '2026-10-15T00:00:00.000Z' });

  const series = await get(s.deps, `/stats/series?metric=reactions&groupBy=account&bucket=week&from=2026-10-12&to=2026-10-25&accounts=${account.id}`, s.read);
  assert.equal(series.status, 200);
  assert.deepEqual(series.body.buckets, ['2026-10-12', '2026-10-19']);
  const groups = series.body.groups as Array<{ label: string; points: Array<{ increase: number }> }>;
  assert.deepEqual(groups.map((g) => [g.label, g.points.map((p) => p.increase)]), [['bluesky @me.bsky.social', [9, 0]]]);

  const ranking = await get(s.deps, `/stats/ranking?by=post&from=2026-10-15&to=2026-10-19&limit=5&launches=${launch.id}`, s.read);
  assert.equal(ranking.status, 200);
  const entries = ranking.body.entries as Array<{ postId: number; score: number; metrics: { reactions: number } }>;
  assert.deepEqual(entries.map((e) => [e.postId, e.score, e.metrics.reactions]), [[post.id, 1, 7]]);
  assert.equal(ranking.body.next, null);
});

test('an account’s growth, and 404 for an account that does not exist', async () => {
  const s = await setup();
  const { account } = await seed(s.registry);
  const growth = await get(s.deps, `/accounts/${account.id}/growth?from=2026-10-17&to=2026-10-17`, s.read);
  assert.equal(growth.status, 200);
  const points = growth.body.points as Array<{ day: string; followers: number; change: { followers: number } }>;
  assert.deepEqual(points.map((p) => [p.day, p.followers, p.change.followers]), [['2026-10-17', 5, 2]]);
  assert.equal((await get(s.deps, '/accounts/999/growth', s.read)).status, 404);
  assert.equal((await get(s.deps, '/accounts/abc/growth', s.read)).status, 400);
});

test('parameters that are not valid are a 400 that says why', async () => {
  const s = await setup();
  const cases: Array<[string, RegExp]> = [
    ['/stats/series', /metric is required/],
    ['/stats/series?metric=likes', /metric is one of/],
    ['/stats/series?metric=views&groupBy=post', /groupBy is one of/],
    ['/stats/series?metric=views&from=2020-01-01&to=2026-10-25', /at most 400 buckets/],
    ['/stats/ranking?limit=0', /limit is an integer/],
    ['/stats/ranking?order=up', /order is one of/],
    ['/stats/overview?from=2026-10-20&to=2026-10-01', /to comes after from/],
    ['/stats/overview?from=soon', /dates/],
    ['/stats/overview?compare=last-year', /compare is previous/],
    ['/stats/overview?compareFrom=2026-10-01', /go together/],
    ['/stats/overview?accounts=1,x', /accounts has an item/],
    ['/stats/overview?channels=', /comma-separated/],
    ['/accounts/1/growth?from=2026-10-01&to=yesterday', /days/],
  ];
  await s.registry.addAccount({ network: 'bluesky', brand: 'personal', label: '@me', settings: {} });
  for (const [path, message] of cases) {
    const answer = await get(s.deps, path, s.read);
    assert.equal(answer.status, 400, path);
    assert.match(answer.body.error?.message ?? '', message, path);
  }
});

test('the OpenAPI document describes the stats routes and their schemas', () => {
  const doc = openApiDocument('https://shipcast.example');
  for (const path of ['/stats/overview', '/stats/series', '/stats/ranking', '/accounts/{accountId}/growth']) {
    const operation = doc.paths[path]?.get as { 'x-scope': string; parameters: Array<{ name: string; schema: { type: string } }> } | undefined;
    assert.equal(operation?.['x-scope'], 'read', path);
  }
  const growth = doc.paths['/accounts/{accountId}/growth']?.get as { parameters: Array<{ name: string; in: string; schema: { type: string } }> };
  assert.deepEqual(growth.parameters.find((p) => p.in === 'path')?.schema.type, 'integer');
  for (const name of ['StatsOverview', 'StatsSeries', 'StatsRanking', 'AccountGrowth']) assert.ok(name in doc.components.schemas, name);
});
