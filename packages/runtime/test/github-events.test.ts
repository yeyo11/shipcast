import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LruEtagCache } from '@shipcast/connectors';
import { CacheEtagStore, githubCaches, GitHubFileCache } from '../src/index.ts';
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
