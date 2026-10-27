import assert from 'node:assert/strict';
import { test } from 'node:test';
import { filtersSet, isRepo, readLaunchesSearch } from '../src/server/launches-search.ts';

test('only what narrows or reorders the list is kept', () => {
  assert.deepEqual(readLaunchesSearch({}), {});
  assert.deepEqual(
    readLaunchesSearch({ q: ' claudio ', status: 'published', trigger: 'article', kind: 'minor', repo: 'yeyo11/claudio', sort: 'oldest', page: '3' }),
    { q: 'claudio', status: 'published', trigger: 'article', kind: 'minor', repo: 'yeyo11/claudio', sort: 'oldest', page: 3 },
  );
});

test('a hand-edited address cannot break the page', () => {
  assert.deepEqual(readLaunchesSearch({ q: '   ', status: 'gone', trigger: 'toString', kind: 'hasOwnProperty', repo: 'not a repo', sort: 'newest', page: '0' }), {});
  assert.deepEqual(readLaunchesSearch({ page: '1' }), {}, 'the first page is the default');
  assert.deepEqual(readLaunchesSearch({ page: 2, repo: '../etc/passwd' }), { page: 2 });
  assert.equal(readLaunchesSearch({ q: 'x'.repeat(500) }).q?.length, 200);
});

test('the Filters button counts the filters, not the words or the order', () => {
  assert.equal(filtersSet({ q: 'x', sort: 'oldest', page: 2 }), 0);
  assert.equal(filtersSet({ status: 'failed', repo: 'a/b' }), 2);
});

test('a repo is owner/name as GitHub writes it', () => {
  assert.ok(isRepo('yeyo11/claudio'));
  assert.ok(isRepo('some-org/my.repo_2'));
  assert.ok(!isRepo('yeyo11'));
  assert.ok(!isRepo('-bad/name'));
  assert.ok(!isRepo('a/b/c'));
});
