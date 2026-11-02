import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ago, brokenLine, credentialWord, dayWord, keyMetric, namesToConnect, shortDay, stateOf, syncAllSummary } from '../src/components/channels/view.ts';

test('a card leads with what its network counts, and the rest beside it', () => {
  assert.deepEqual(keyMetric('bluesky', { followers: 1842, following: 312, posts: null }), { value: 1842, label: 'Followers', others: '312 following' });
  assert.deepEqual(keyMetric('telegram', { followers: 268 }), { value: 268, label: 'Subscribers', others: null });
  assert.equal(keyMetric('linkedin', { followers: 10 }), null);
  assert.equal(keyMetric('discord', null), null);
  assert.deepEqual(keyMetric('reddit', { followers: 5, extra: { karma: 1200 } }), { value: 1200, label: 'Karma', others: '5 followers' });
  assert.equal(keyMetric('mastodon', null)?.value, null);
});

test('freshness reads in the board’s short words', () => {
  const now = '2026-10-31T12:00:00.000Z';
  assert.equal(ago('2026-10-31T11:59:40.000Z', now), 'just now');
  assert.equal(ago('2026-10-31T11:48:00.000Z', now), '12 min ago');
  assert.equal(ago('2026-10-31T10:00:00.000Z', now), '2 h ago');
  assert.equal(ago('2026-10-28T10:00:00.000Z', now), '3 d ago');
  assert.equal(shortDay('2026-10-26T08:00:00.000Z'), '26 Oct');
  assert.equal(dayWord('2026-10-31T01:00:00.000Z', now), 'today');
  assert.equal(dayWord('2026-10-30T23:00:00.000Z', now), 'yesterday');
  assert.equal(dayWord('2026-10-26T23:00:00.000Z', now), 'on 26 Oct');
});

test('a broken account says what failed and what it stops', () => {
  assert.equal(brokenLine({ name: 'LinkedIn', channel: 'linkedin' }, 'The token expired on 28 Oct: sign in to LinkedIn again'), 'The token expired on 28 Oct: sign in to LinkedIn again. Nothing goes out to LinkedIn until you reconnect it.');
  assert.equal(brokenLine({ name: 'Google Search Console' }, null), 'Its last check failed. Google Search Console’s numbers are not read until you reconnect it.');
  assert.equal(brokenLine({ name: 'Anthropic API', ai: true }, 'Refused.'), 'Refused. Anthropic API writes nothing until you reconnect it.');
  assert.equal(stateOf('ok'), 'ok');
  assert.equal(stateOf('failed'), 'failed');
  assert.equal(stateOf(null), 'unchecked');
});

test('the connect card names a few networks, and the disconnect what reconnecting needs', () => {
  assert.equal(namesToConnect(['Threads', 'Reddit']), 'Threads, Reddit');
  assert.equal(namesToConnect(['A', 'B', 'C', 'D', 'E', 'F']), 'A, B, C, D, E…');
  assert.equal(namesToConnect([]), 'Another account on a network you use');
  assert.equal(credentialWord({ auth: 'form', name: 'Bluesky', fields: [{ label: 'Handle', secret: false }, { label: 'App password', secret: true }] }), 'a new app password');
  assert.equal(credentialWord({ auth: 'oauth', name: 'LinkedIn', fields: [] }), 'authorising Shipcast on LinkedIn again');
});

test('Sync all says how many of the tab synced, and names what did not', () => {
  const ok = (name: string) => ({ name, state: 'completed' as const });
  assert.deepEqual(syncAllSummary([ok('Bluesky'), ok('Mastodon')]), { tone: 'ok', title: 'Synced all 2' });
  assert.deepEqual(syncAllSummary([ok('Bluesky')]), { tone: 'ok', title: 'Synced Bluesky' });
  assert.deepEqual(syncAllSummary([ok('Bluesky'), { name: 'Threads', state: 'failed', problem: 'the token expired' }, ok('Mastodon')]), {
    tone: 'bad',
    title: 'Synced 2 of 3',
    text: 'Threads failed: the token expired',
  });
  assert.deepEqual(syncAllSummary([ok('Bluesky'), { name: 'Reddit', state: 'queued' }], ['Instagram']), {
    tone: 'ok',
    title: 'Synced 1 of 2',
    text: 'Reddit still syncs: reload the page in a minute · Instagram needs reconnecting first',
  });
});
