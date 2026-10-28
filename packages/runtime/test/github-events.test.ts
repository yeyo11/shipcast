import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LruEtagCache } from '@shipcast/connectors';
import { memoryRegistry } from '@shipcast/engine/testing';
import { CacheEtagStore, githubCaches, githubEventEffects, GitHubFileCache, pollGitHub, takeGitHubPoll } from '../src/index.ts';
import { MemoryCache } from '../src/redis/index.ts';

test('the file cache keeps the launches repo’s settings files at HEAD and a tag’s launch.yml, nothing else', () => {
  const files = new GitHubFileCache(new MemoryCache(), () => 'yeyo11/launches');
  assert.ok(files.keeps('yeyo11/launches', 'brand.yml', 'HEAD'));
  assert.ok(files.keeps('Yeyo11/Launches', 'projects.yml', 'HEAD'), 'a repo name is case-insensitive');
  assert.ok(files.keeps('yeyo11/launches', 'launches/claudio-v1/launch.yml', 'HEAD'));
  assert.ok(files.keeps('yeyo11/launches', 'launches/claudio-v1/pack.json', 'HEAD'));
  assert.ok(files.keeps('yeyo11/claudio', '.github/launch.yml', 'v1.0.0'));
  assert.equal(files.keeps('yeyo11/launches', 'brand.yml', 'shipcast/claudio-v1'), false, 'a draft branch changes under the owner’s edits');
  assert.equal(files.keeps('yeyo11/launches', 'src/content/posts/en/x.md', 'HEAD'), false);
  assert.equal(files.keeps('yeyo11/claudio', '.github/launch.yml', 'HEAD'), false, 'a project’s default branch is not watched');
});

test('forgetting paths drops them at HEAD; forgetting a repo drops everything of it on every reader of the cache', async () => {
  const cache = new MemoryCache();
  const one = new GitHubFileCache(cache, () => 'yeyo11/launches');
  const two = new GitHubFileCache(cache, () => 'yeyo11/launches');
  await one.set('yeyo11/launches', 'brand.yml', 'HEAD', 'a');
  await one.set('yeyo11/launches', 'projects.yml', 'HEAD', 'b');
  await one.set('yeyo11/claudio', '.github/launch.yml', 'v1', 'c');
  assert.equal(await two.get('yeyo11/launches', 'brand.yml', 'HEAD'), 'a', 'a replica on the same cache reads it');
  await two.forget('yeyo11/launches', ['brand.yml']);
  assert.equal(await one.get('yeyo11/launches', 'brand.yml', 'HEAD'), undefined);
  assert.equal(await one.get('yeyo11/launches', 'projects.yml', 'HEAD'), 'b');
  await two.forget('yeyo11/launches');
  assert.equal(await one.get('yeyo11/launches', 'projects.yml', 'HEAD'), undefined);
  assert.equal(await one.get('yeyo11/claudio', '.github/launch.yml', 'v1'), 'c', 'another repo is untouched');
});

test('the ETags live in the shared cache when there is one, in a bounded LRU otherwise', async () => {
  const shared = githubCaches(new MemoryCache(), () => undefined);
  assert.ok(shared.etags instanceof CacheEtagStore);
  await shared.etags.set('k', { etag: '"1"', body: 'x', status: 200, headers: { a: 'b' } });
  assert.deepEqual(await shared.etags.get('k'), { etag: '"1"', body: 'x', status: 200, headers: { a: 'b' } });
  assert.ok(githubCaches(undefined, () => undefined).etags instanceof LruEtagCache);
});

test("a launches repo pull request's changes queue its snapshot; anything else of a pull request does not", () => {
  const pr = (action: string, repo = 'yeyo11/launches') => githubEventEffects('pull_request', { action, repository: { full_name: repo }, pull_request: { number: 7 } }, 'yeyo11/launches');
  for (const action of ['opened', 'synchronize', 'edited', 'closed', 'reopened']) assert.deepEqual(pr(action), { snapshot: 7 }, action);
  assert.deepEqual(pr('labeled'), {});
  assert.deepEqual(pr('opened', 'yeyo11/claudio'), {}, 'a pull request of another repo');
});

test('a push to the default branch forgets the files it touched; a tag, a force-push or a long push forgets the repo', () => {
  const repository = { full_name: 'yeyo11/launches', default_branch: 'main' };
  const push = (payload: Record<string, unknown>) => githubEventEffects('push', { repository, ...payload }, 'yeyo11/launches');
  assert.deepEqual(push({ ref: 'refs/heads/main', commits: [{ added: ['a/pack.json'], modified: ['brand.yml'], removed: [] }, { modified: ['brand.yml'] }] }), {
    forget: { repo: 'yeyo11/launches', paths: ['a/pack.json', 'brand.yml'] },
  });
  assert.deepEqual(push({ ref: 'refs/heads/launch/x', commits: [{ modified: ['brand.yml'] }] }), {}, 'a draft branch is the pull request’s');
  assert.deepEqual(push({ ref: 'refs/tags/v1', commits: [] }), { forget: { repo: 'yeyo11/launches' } });
  assert.deepEqual(push({ ref: 'refs/heads/main', forced: true, commits: [] }), { forget: { repo: 'yeyo11/launches' } });
  assert.deepEqual(push({ ref: 'refs/heads/main', commits: Array.from({ length: 20 }, () => ({ modified: ['x'] })) }), { forget: { repo: 'yeyo11/launches' } });
  assert.deepEqual(githubEventEffects('release', { repository }, 'yeyo11/launches'), {});
});

test('the GitHub poll is taken at most once an hour, whatever the rounds’ interval', async () => {
  const registry = await memoryRegistry();
  const at = (minutes: number) => new Date(Date.parse('2026-10-28T10:00:00Z') + minutes * 60_000);
  assert.equal(await takeGitHubPoll(registry, at(0)), true);
  assert.equal(await takeGitHubPoll(registry, at(5)), false);
  assert.equal(await takeGitHubPoll(registry, at(59)), false);
  assert.equal(await takeGitHubPoll(registry, at(60)), true);
});

test('the poll forgets the launches repo’s kept files and reads the open pull requests again', async () => {
  const forgotten: Array<[string, readonly string[] | undefined]> = [];
  const lines = await pollGitHub({
    drafts: { refreshOpen: async () => ({ refreshed: 2, problems: ['x: 500'] }) },
    files: { forget: async (repo, paths) => void forgotten.push([repo, paths]) },
    launchesRepo: 'yeyo11/launches',
  });
  assert.deepEqual(forgotten, [['yeyo11/launches', undefined]]);
  assert.deepEqual(lines, ['GitHub poll: 2 drafts pull requests read', '  x: 500']);
});
