import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pullRequestNumber } from '../src/index.ts';

// One reading for the engine's review and publishing and the runtime's scheduled posts, which had a
// regex each (publishing's and the runtime's anchored at the end: a drafted launch's detail is the
// bare URL, so the looser reading changes nothing for them)

const detail = (value: string | null) => ({ detail: value });

test('pullRequestNumber reads the number of a pull request URL anywhere in the detail', () => {
  assert.equal(pullRequestNumber(detail('https://github.com/me/launches/pull/12')), 12);
  assert.equal(pullRequestNumber(detail('https://github.com/me/launches/pull/12: closed without merging')), 12);
  assert.equal(pullRequestNumber(detail('https://github.com/me/launches/pull/7/files')), 7);
  assert.equal(pullRequestNumber(detail(null)), undefined);
  assert.equal(pullRequestNumber(detail('')), undefined);
  assert.equal(pullRequestNumber(detail('direct:abc123 https://github.com/me/launches/commit/abc123')), undefined);
  assert.equal(pullRequestNumber(detail('https://github.com/me/launches/pull/0')), undefined);
});
