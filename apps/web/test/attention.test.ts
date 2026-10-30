import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseFailureKey } from '@shipcast/schema/failures';
import { canonicalKey, launchStoreKey } from '@shipcast/engine';
import { aPublishedLaunch, memoryRegistry } from '@shipcast/engine/testing';
import { ATTENTION_KEY, attentionItems, attentionLabel, buildAttention } from '../src/server/attention.ts';
import { attentionFor } from '../src/server/attention.server.ts';

const now = new Date('2026-10-26T12:00:00Z');
const launches = [
  { id: 1, repo: 'me/alpha', ref: 'v1.0.0', status: 'drafted', updatedAt: '2026-10-26T10:00:00.000Z' },
  { id: 2, repo: 'me/beta', ref: 'v2.0.0', status: 'drafted', updatedAt: '2026-10-26T11:00:00.000Z' },
  { id: 3, repo: 'me/gamma', ref: 'v3.0.0', status: 'published', updatedAt: '2026-10-26T09:00:00.000Z' },
];
const base = { launches, failures: [], brokenAccounts: [], commentsWaiting: 0, scheduled: [], now };
const fail = (key: string, value = 'refused') => ({ key, value });

test('nothing to do is an empty list and a calm label', () => {
  const a = buildAttention({ ...base, launches: [launches[2]!] });
  assert.deepEqual(a, { count: 0, items: [] });
  assert.equal(attentionLabel(0), 'Nothing needs you');
});

test('a drafted launch waits for approval, unless it already failed somewhere', () => {
  const a = buildAttention({ ...base, failures: [fail('publish-failed:2:devto'), fail('publish-failed:2:mastodon')] });
  assert.deepEqual(a.items.map((i) => i.kind), ['approve', 'retry']);
  assert.equal(a.items[0]?.key, 'launch:1:waiting:2026-10-26T10:00:00.000Z');
  assert.match(a.items[1]?.key ?? '', /^launch:2:failed:[0-9a-z]+$/);
  assert.match(a.items[1]?.text ?? '', /beta v2\.0\.0 failed on devto, mastodon/);
});

test('failure keys of unknown launches or of another shape are ignored', () => {
  assert.equal(parseFailureKey('publish-failed:x:devto'), null);
  assert.deepEqual(parseFailureKey('publish-failed:7:devto'), { launchId: 7, channel: 'devto' });
  assert.equal(buildAttention({ ...base, failures: [fail('publish-failed:99:devto')] }).items.length, 2);
});

test('comments and broken accounts count; scheduled posts inform without counting', () => {
  const a = buildAttention({
    ...base,
    launches: [],
    commentsWaiting: 3,
    brokenAccounts: [{ id: 5, label: 'main', network: 'mastodon', problem: 'token revoked' }],
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

test('a dismissed line leaves the list and the count; the others stay', () => {
  const all = attentionItems({ ...base, commentsWaiting: 2, newestWaitingComment: 41 });
  assert.deepEqual(all.map((i) => i.key), ['launch:1:waiting:2026-10-26T10:00:00.000Z', 'launch:2:waiting:2026-10-26T11:00:00.000Z', 'comments:waiting:41']);
  const a = buildAttention({ ...base, commentsWaiting: 2, newestWaitingComment: 41, dismissed: new Set(['launch:1:waiting:2026-10-26T10:00:00.000Z', 'comments:waiting:41']) });
  assert.equal(a.count, 1);
  assert.deepEqual(a.items.map((i) => i.text), ['beta v2.0.0 waits for your approval']);
});

test('a dismissal holds while the condition lasts and a changed condition is a new line', () => {
  const key = (input: Parameters<typeof attentionItems>[0], kind: string) => attentionItems(input).find((i) => i.kind === kind)?.key;
  // A new comment arriving
  assert.notEqual(key({ ...base, commentsWaiting: 2, newestWaitingComment: 41 }, 'reply'), key({ ...base, commentsWaiting: 2, newestWaitingComment: 42 }, 'reply'));
  // The same failure read twice is the same line; another message, or the launch moved by a retry, is not
  const failed = { ...base, failures: [fail('publish-failed:2:devto', 'rate limited')] };
  assert.equal(key(failed, 'retry'), key(failed, 'retry'));
  assert.notEqual(key(failed, 'retry'), key({ ...failed, failures: [fail('publish-failed:2:devto', 'token expired')] }, 'retry'));
  const retried = { ...failed, launches: launches.map((l) => (l.id === 2 ? { ...l, updatedAt: '2026-10-26T11:30:00.000Z' } : l)) };
  assert.notEqual(key(failed, 'retry'), key(retried, 'retry'));
  // A drafted launch drafted again
  assert.notEqual(key(base, 'approve'), key({ ...base, launches: launches.map((l) => ({ ...l, updatedAt: '2026-10-27T00:00:00.000Z' })) }, 'approve'));
  // An account broken for another reason
  const broken = (problem: string) => ({ ...base, brokenAccounts: [{ id: 5, label: 'main', network: 'mastodon', problem }] });
  assert.notEqual(key(broken('token revoked'), 'reconnect'), key(broken('instance down'), 'reconnect'));
});

test('a repo whose traffic GitHub refuses needs the App’s permission, and counts', () => {
  const problem = { key: 'metrics-problem:github-traffic:me/alpha', value: "GitHub: read me/alpha's traffic: 403 Resource not accessible by integration" };
  const a = buildAttention({ ...base, launches: [], metricProblems: [problem] });
  assert.equal(a.count, 1);
  assert.deepEqual(a.items.map((i) => [i.kind, i.text, i.action, i.target]), [['permission', 'GitHub refuses me/alpha’s traffic: the App needs Administration: read on it', 'Check the GitHub App', { to: '/settings' }]]);
  const again = buildAttention({ ...base, launches: [], metricProblems: [problem], dismissed: new Set([a.items[0]!.key]) });
  assert.equal(again.count, 0, 'dismissed while the same refusal lasts');
});

test('every key a line can have is one a dismissal accepts, and nothing else is', () => {
  const items = attentionItems({
    ...base,
    failures: [fail('publish-failed:1:devto', 'a message: with "quotes" and spaces')],
    commentsWaiting: 1,
    newestWaitingComment: 9,
    brokenAccounts: [{ id: 3, label: 'x', network: 'bluesky', problem: null }],
    scheduled: [{ launchId: 2, scheduledAt: '2026-10-26T13:00:00Z' }],
    metricProblems: [{ key: 'metrics-problem:github-traffic:me/alpha.js', value: '403' }],
  });
  assert.equal(items.length, 6);
  for (const item of items) assert.match(item.key, ATTENTION_KEY);
  for (const bad of ['', 'launch:', 'other:1', 'launch:1 waiting', `launch:${'x'.repeat(200)}`]) assert.doesNotMatch(bad, ATTENTION_KEY);
});

test('a page Google files under another canonical is a line on its launch, new again when Google picks yet another', () => {
  const canonicals = [{ launchId: 3, pages: [{ url: 'https://josegarrido.dev/en/gamma/', googleCanonical: 'https://dev.to/me/gamma-1' }] }];
  const [line] = attentionItems({ ...base, launches: [launches[2]!], canonicals });
  assert.equal(line?.kind, 'canonical');
  assert.match(line!.text, /Google files https:\/\/josegarrido\.dev\/en\/gamma\/ under https:\/\/dev\.to\/me\/gamma-1/);
  assert.deepEqual(line?.target, { to: '/launches/$id', params: { id: '3' } });
  assert.match(line!.key, ATTENTION_KEY);
  const other = attentionItems({ ...base, launches: [launches[2]!], canonicals: [{ launchId: 3, pages: [{ url: 'https://josegarrido.dev/en/gamma/', googleCanonical: 'https://hashnode.dev/gamma' }] }] });
  assert.notEqual(other[0]?.key, line?.key);
  assert.deepEqual(attentionItems({ ...base, launches: [launches[2]!], canonicals: [{ launchId: 99, pages: canonicals[0]!.pages }] }), [], 'a launch no longer listed has no line');
});

test('a canonical cursor that is not a list of pages is skipped, and the bell still opens', async () => {
  const registry = await memoryRegistry();
  const { launch } = await aPublishedLaunch(registry, []);
  const other = await aPublishedLaunch(registry, [], { ref: 'v2.0.0' });
  await registry.cursors.setCursor(canonicalKey(launch.id), 'not json');
  await registry.cursors.setCursor(canonicalKey(other.launch.id), JSON.stringify([{ url: 'https://josegarrido.dev/en/a/', googleCanonical: 'https://dev.to/me/a' }]));
  const attention = await attentionFor(registry);
  const canonical = attention.items.filter((i) => i.kind === 'canonical');
  assert.equal(canonical.length, 1);
  assert.match(canonical[0]!.text, /dev\.to/);
});

test("with launch-store, a launch whose copy in Shipcast differs from its pull request is a line, new again when something else differs", async () => {
  const storeDifferences = [{ launchId: 1, differences: ['launches/alpha/v1.0.0/bluesky.md: no draft in the database', 'pack.json: no pack in the database'] }];
  const line = attentionItems({ ...base, storeDifferences }).find((i) => i.kind === 'drift');
  assert.match(line!.text, /alpha v1\.0\.0: Shipcast's copy differs from the pull request \(launches\/alpha\/v1\.0\.0\/bluesky\.md: no draft in the database and 1 more\)/);
  assert.deepEqual(line?.target, { to: '/launches/$id', params: { id: '1' } });
  assert.match(line!.key, ATTENTION_KEY);
  const other = attentionItems({ ...base, storeDifferences: [{ launchId: 1, differences: ['pack.json: no pack in the database'] }] }).find((i) => i.kind === 'drift');
  assert.notEqual(other?.key, line?.key);
  assert.equal(attentionItems({ ...base, storeDifferences: [{ launchId: 1, differences: [] }] }).filter((i) => i.kind === 'drift').length, 0);

  // From the engine's cursor, as the check writes it; one that does not parse is skipped
  const registry = await memoryRegistry();
  const { launch } = await aPublishedLaunch(registry, []);
  const second = await aPublishedLaunch(registry, [], { ref: 'v2.0.0' });
  await registry.cursors.setCursor(launchStoreKey(launch.id), JSON.stringify({ at: now.toISOString(), differences: ['og.png: no media in the database'] }));
  await registry.cursors.setCursor(launchStoreKey(second.launch.id), 'not json');
  const drift = (await attentionFor(registry)).items.filter((i) => i.kind === 'drift');
  assert.equal(drift.length, 1);
  assert.match(drift[0]!.text, /og\.png: no media in the database/);
});
