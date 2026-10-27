import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LaunchStatus, NewLaunch, Registry } from '../src/index.ts';
import { memoryRegistry } from '../src/testing.ts';

/** Claims a launch and sets its status; launches claimed one after another are ordered by creation */
async function add(registry: Registry, launch: Partial<NewLaunch> & { ref: string }, status: LaunchStatus = 'published') {
  const { launch: claimed } = await registry.claim({ repo: 'yeyo11/claudio', trigger: 'release', kind: 'minor', brand: 'personal', ...launch });
  return registry.setStatus(claimed.id, status);
}

async function seeded() {
  const registry = await memoryRegistry();
  await add(registry, { ref: 'v1.0.0', kind: 'launch' });
  await add(registry, { ref: 'v1.1.0' }, 'failed');
  await add(registry, { repo: 'yeyo11/shipcast', ref: 'v0.1.0', kind: 'launch' }, 'drafted');
  await add(registry, { repo: 'yeyo11/launches', ref: 'article:hello-world-from-shipcast', trigger: 'article', kind: 'launch' });
  await add(registry, { repo: 'yeyo11/shipcast', ref: 'v0.2.0', trigger: 'manual' }, 'skipped');
  return registry;
}

test('the list is cut into numbered pages by the database, the total counting every match', async () => {
  const registry = await memoryRegistry();
  for (let i = 0; i < 12; i++) await add(registry, { ref: `v0.${i}.0` });
  const first = await registry.launchList({ pageSize: 5 });
  assert.equal(first.total, 12);
  assert.equal(first.pages, 3);
  assert.equal(first.launches.length, 5);
  assert.equal(first.launches[0]!.ref, 'v0.11.0', 'newest first');
  const ids = new Set<number>();
  for (const page of [1, 2, 3]) for (const l of (await registry.launchList({ pageSize: 5, page })).launches) ids.add(l.id);
  assert.equal(ids.size, 12, 'no launch on two pages, none missed');
  assert.equal((await registry.launchList({ pageSize: 5, page: 99 })).page, 3, 'a page past the end shows the last');
  assert.equal((await registry.launchList({ pageSize: 5, order: 'oldest' })).launches[0]!.ref, 'v0.0.0', 'oldest first when asked');
  const empty = await memoryRegistry();
  assert.deepEqual(await empty.launchList(), { launches: [], total: 0, page: 1, pageSize: 24, pages: 1 });
});

test('the filters narrow by status, trigger, kind, repo and words, together', async () => {
  const registry = await seeded();
  const refs = async (f: Parameters<Registry['launchList']>[0]) => (await registry.launchList(f)).launches.map((l) => l.ref);
  assert.deepEqual(await refs({ status: 'published' }), ['article:hello-world-from-shipcast', 'v1.0.0']);
  assert.deepEqual(await refs({ trigger: 'manual' }), ['v0.2.0']);
  assert.deepEqual(await refs({ kind: 'launch' }), ['article:hello-world-from-shipcast', 'v0.1.0', 'v1.0.0']);
  assert.deepEqual(await refs({ repo: 'yeyo11/shipcast' }), ['v0.2.0', 'v0.1.0']);
  assert.deepEqual(await refs({ repo: 'yeyo11/shipcast', kind: 'launch' }), ['v0.1.0']);
  assert.deepEqual(await refs({ search: 'SHIPCAST' }), ['v0.2.0', 'article:hello-world-from-shipcast', 'v0.1.0'], 'the repo or the ref, any case');
  assert.deepEqual(await refs({ search: 'v1.1' }), ['v1.1.0']);
  assert.deepEqual(await refs({ search: 'Hello, World!' }), ['article:hello-world-from-shipcast'], "an article's title, as its ref holds it");
  assert.deepEqual(await refs({ search: '100%' }), [], "LIKE's wildcards are letters");
  assert.deepEqual(await refs({ search: '   ' }), (await refs({})), 'blank words are no filter');
});

test('the API keeps its keyset pages, now filtered and in either order', async () => {
  const registry = await seeded();
  const walk = async (order: 'newest' | 'oldest') => {
    const seen: string[] = [];
    let after: { createdAt: string; id: number } | undefined;
    for (;;) {
      const page = await registry.launchesPage({ limit: 2, order, ...(after && { after }) });
      seen.push(...page.launches.map((l) => l.ref));
      if (!page.next) return seen;
      after = page.next;
    }
  };
  const newest = await walk('newest');
  assert.equal(newest.length, 5);
  assert.deepEqual(await walk('oldest'), [...newest].reverse());
  const first = await registry.launchesPage({ limit: 1, repo: 'yeyo11/shipcast' });
  assert.deepEqual(first.launches.map((l) => l.ref), ['v0.2.0']);
  const second = await registry.launchesPage({ limit: 1, repo: 'yeyo11/shipcast', after: first.next! });
  assert.deepEqual(second.launches.map((l) => l.ref), ['v0.1.0']);
  assert.equal(second.next, undefined);
});

test('the facets offer only what some launch has, with how many', async () => {
  const facets = await (await seeded()).launchFacets();
  assert.deepEqual(facets.repos, [
    { repo: 'yeyo11/claudio', count: 2 },
    { repo: 'yeyo11/launches', count: 1 },
    { repo: 'yeyo11/shipcast', count: 2 },
  ]);
  assert.deepEqual(facets.statuses, [
    { status: 'drafted', count: 1 },
    { status: 'published', count: 2 },
    { status: 'skipped', count: 1 },
    { status: 'failed', count: 1 },
  ]);
  assert.deepEqual(facets.triggers, [
    { trigger: 'release', count: 3 },
    { trigger: 'manual', count: 1 },
    { trigger: 'article', count: 1 },
  ]);
  assert.deepEqual(facets.kinds, [
    { kind: 'launch', count: 3 },
    { kind: 'minor', count: 2 },
  ]);
});
