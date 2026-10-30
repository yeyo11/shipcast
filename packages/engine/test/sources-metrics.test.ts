import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Brand } from '@shipcast/schema';
import { collectHourly, collectMetrics, furtherRepoSource, type MetricSources, type Repositories } from '../src/index.ts';
import { memoryRegistry } from '../src/testing/index.ts';

/*
 * A launch about several repos (launch-sources): each further repo's stars, forks and watchers are
 * read and kept apart under `github:<owner/name>`, so the launch's own `github` numbers stay its
 * primary repo's. Without `furtherRepos` (the flag off) nothing changes.
 */

const brand = Brand.parse({ id: 'personal', displayName: 'Me', site: 'https://josegarrido.dev', github: 'yeyo11' });
const NOW = new Date('2026-10-30T12:00:00Z');

async function published(registry: Repositories) {
  const { launch } = await registry.launches.claim({ repo: 'yeyo11/claudio', ref: 'v0.9.0', trigger: 'release', kind: 'launch', brand: 'personal' });
  await registry.launches.setStatus(launch.id, 'published', 'https://github.com/yeyo11/launches/pull/3');
  await registry.sources.replace(launch.id, [
    { kind: 'repo_release', role: 'primary', repo: 'yeyo11/claudio', ref: 'v0.9.0' },
    { kind: 'repo', role: 'context', repo: 'yeyo11/claudio-web' },
  ]);
  return launch;
}

const STARS: Record<string, number> = { 'yeyo11/claudio': 120, 'yeyo11/claudio-web': 7 };
const latest = async (registry: Repositories, id: number) => Object.fromEntries((await registry.metrics.latestMetrics(id)).filter((m) => m.source.startsWith('github')).map((m) => [`${m.source}.${m.name}`, m.value]));

test('each further repo’s numbers are kept apart from the primary repo’s', async () => {
  const registry = await memoryRegistry();
  const launch = await published(registry);
  const asked: string[] = [];
  const sources: MetricSources = {
    github: { repoStats: async (repo) => (asked.push(repo), { stars: STARS[repo]!, forks: 1, watchers: 2 }) },
    furtherRepos: (ids) => registry.sources.furtherRepos(ids),
  };
  const result = await collectMetrics(registry, brand, sources, NOW);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(asked.sort(), ['yeyo11/claudio', 'yeyo11/claudio-web']);
  const values = await latest(registry, launch.id);
  assert.equal(values['github.stars'], 120, 'the launch’s stars stay its primary repo’s');
  assert.equal(values[`${furtherRepoSource('yeyo11/claudio-web')}.stars`], 7);
  assert.equal(values['github:yeyo11/claudio-web.forks'], 1);
});

test('the hourly reads take a further repo’s counts from the split reader', async () => {
  const registry = await memoryRegistry();
  const launch = await published(registry);
  const counted: string[] = [];
  const sources: MetricSources = {
    githubRepo: {
      counts: async (repo) => (counted.push(repo), { stars: STARS[repo]!, forks: 0, watchers: 0 }),
      traffic: async () => Promise.reject(new Error('not read here')),
      history: async () => Promise.reject(new Error('not read here')),
    },
    furtherRepos: (ids) => registry.sources.furtherRepos(ids),
  };
  await collectHourly(registry, brand, sources, NOW);
  assert.ok(counted.includes('yeyo11/claudio-web'));
  assert.equal((await latest(registry, launch.id))['github:yeyo11/claudio-web.stars'], 7);
});

test('without furtherRepos (the flag off) only the primary repo is read', async () => {
  const registry = await memoryRegistry();
  const launch = await published(registry);
  const asked: string[] = [];
  await collectMetrics(registry, brand, { github: { repoStats: async (repo) => (asked.push(repo), { stars: 1, forks: 0, watchers: 0 }) } }, NOW);
  assert.deepEqual(asked, ['yeyo11/claudio']);
  assert.deepEqual(Object.keys(await latest(registry, launch.id)).filter((k) => k.startsWith('github:')), []);
});
