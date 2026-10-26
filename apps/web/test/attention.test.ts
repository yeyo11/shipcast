import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attentionLabel, buildAttention, parseFailureKey } from '../src/server/attention.ts';

const now = new Date('2026-10-26T12:00:00Z');
const launches = [
  { id: 1, repo: 'me/alpha', ref: 'v1.0.0', status: 'drafted' },
  { id: 2, repo: 'me/beta', ref: 'v2.0.0', status: 'drafted' },
  { id: 3, repo: 'me/gamma', ref: 'v3.0.0', status: 'published' },
];
const base = { launches, failureKeys: [], brokenAccounts: [], commentsWaiting: 0, scheduled: [], now };

test('nothing to do is an empty list and a calm label', () => {
  const a = buildAttention(base);
  assert.deepEqual(a, { count: 0, items: [] });
  assert.equal(attentionLabel(0), 'Nothing needs you');
});

test('a drafted launch waits for approval, unless it already failed somewhere', () => {
  const a = buildAttention({ ...base, failureKeys: ['publish-failed:2:devto', 'publish-failed:2:mastodon'] });
  assert.deepEqual(a.items.map((i) => i.key), ['approve:1', 'retry:2']);
  assert.match(a.items[1]?.text ?? '', /beta v2\.0\.0 failed on devto, mastodon/);
});

test('failure keys of unknown launches or of another shape are ignored', () => {
  assert.equal(parseFailureKey('publish-failed:x:devto'), null);
  assert.deepEqual(parseFailureKey('publish-failed:7:devto'), { launchId: 7, channel: 'devto' });
  assert.equal(buildAttention({ ...base, failureKeys: ['publish-failed:99:devto'] }).items.length, 2);
});

test('comments and broken accounts count; scheduled posts inform without counting', () => {
  const a = buildAttention({
    ...base,
    launches: [],
    commentsWaiting: 3,
    brokenAccounts: [{ id: 5, label: 'main', network: 'mastodon' }],
    scheduled: [],
  });
  assert.equal(a.count, 2);
  assert.deepEqual(a.items.map((i) => i.kind), ['reply', 'reconnect']);
  assert.deepEqual(a.items[1]?.target, { to: '/channels', search: { focus: '5' } });
});

test('only posts going out within a day are listed, grouped by launch, and they are not counted', () => {
  const a = buildAttention({
    ...base,
    launches: [launches[2]!],
    scheduled: [
      { launchId: 3, scheduledAt: '2026-10-26T14:00:00Z' },
      { launchId: 3, scheduledAt: '2026-10-26T13:00:00Z' },
      { launchId: 3, scheduledAt: '2026-10-29T13:00:00Z' },
    ],
  });
  assert.equal(a.count, 0);
  assert.equal(a.items.length, 1);
  assert.match(a.items[0]?.text ?? '', /2 posts of gamma v3\.0\.0 go out in 1 h/);
});

test('the label says how many', () => {
  assert.equal(attentionLabel(1), '1 thing needs you');
  assert.equal(attentionLabel(3), '3 things need you');
});
