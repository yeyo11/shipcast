import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CallCount, TelemetryStore, TimingCount } from '@shipcast/engine';
import { classify, Flags, instrumentFetch, PROBE_ORIGIN, quotaOf, TelemetryRecorder, withOrigin } from '../src/index.ts';

test('a call is labelled by provider and endpoint, with no id, name, token or query', () => {
  assert.deepEqual(classify('https://api.github.com/repos/yeyo11/shipcast/pulls/42/files?per_page=100&access_token=x'), { provider: 'github', endpoint: '/repos/:owner/:repo/pulls/:n/files' });
  assert.deepEqual(classify('https://api.github.com/repos/yeyo11/launches/contents/drafts/rea/linkedin.md?ref=launch/x'), { provider: 'github', endpoint: '/repos/:owner/:repo/contents/*' });
  assert.deepEqual(classify('https://api.github.com/repos/yeyo11/launches/git/ref/heads/launch/rea-v1'), { provider: 'github', endpoint: '/repos/:owner/:repo/git/ref/*' });
  assert.deepEqual(classify('https://raw.githubusercontent.com/yeyo11/shipcast/main/README.md'), { provider: 'github', endpoint: '/:owner/:repo/:ref/*' });
  assert.deepEqual(classify('https://api.telegram.org/bot123456:AAE-secret_token/sendMessage'), { provider: 'telegram', endpoint: '/bot:token/sendMessage' });
  assert.deepEqual(classify('https://bsky.social/xrpc/app.bsky.feed.getPosts?uris=at://x'), { provider: 'bluesky', endpoint: '/xrpc/app.bsky.feed.getPosts' });
  assert.deepEqual(classify('https://mastodon.social/api/v1/statuses/113456789012345678/context'), { provider: 'mastodon', endpoint: '/api/v1/statuses/:n/context' });
  assert.deepEqual(classify('https://fosstodon.org/api/v1/accounts/verify_credentials'), { provider: 'mastodon', endpoint: '/api/v1/accounts/verify_credentials' });
  assert.deepEqual(classify('https://graph.instagram.com/v21.0/17841400000000000/media?access_token=IGQ'), { provider: 'instagram', endpoint: '/v21.0/:n/media' });
  assert.deepEqual(classify('https://dev.to/api/articles/me/published'), { provider: 'devto', endpoint: '/api/articles/me/published' });
  assert.deepEqual(classify('https://josegarrido.dev/blog/rea-article'), { provider: 'josegarrido.dev', endpoint: '/blog/rea-article' });
  assert.equal(classify('not a url').provider, 'invalid');
  for (const label of [classify('https://api.telegram.org/bot1:SECRET/getMe'), classify('https://graph.threads.net/me?access_token=SECRET')]) {
    assert.doesNotMatch(JSON.stringify(label), /SECRET/);
  }
});

test('quota headers become the share used', () => {
  assert.deepEqual(quotaOf(new Headers({ 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4000' })), { used: 0.2, limit: 5000 });
  assert.deepEqual(quotaOf(new Headers({ 'ratelimit-limit': '3000', 'ratelimit-remaining': '1500' })), { used: 0.5, limit: 3000 });
  assert.deepEqual(quotaOf(new Headers({ 'x-app-usage': '{"call_count":12,"total_cputime":3,"total_time":40}' })), { used: 0.4 });
  assert.equal(quotaOf(new Headers()), undefined);
});

/** A store that keeps what is written, or fails while `failing` is set */
function fakeStore() {
  const calls: CallCount[] = [];
  const timings: TimingCount[] = [];
  const state = { failing: false };
  const store = {
    addCalls: async (rows: CallCount[]) => {
      if (state.failing) throw new Error('database away');
      calls.push(...structuredClone(rows));
    },
    addTimings: async (rows: TimingCount[]) => {
      if (state.failing) throw new Error('database away');
      timings.push(...structuredClone(rows));
    },
  } as unknown as TelemetryStore;
  return { store, calls, timings, state };
}

test('a counted fetch changes nothing and counts each call under its origin', async () => {
  const { store, calls } = fakeStore();
  const recorder = new TelemetryRecorder({ process: 'test', store: () => store, now: () => new Date('2026-10-28T14:35:00Z') });
  const answer = new Response('{"ok":true}', { status: 200, headers: { 'content-length': '11', 'x-ratelimit-limit': '100', 'x-ratelimit-remaining': '90' } });
  const inner = (async () => answer) as unknown as typeof fetch;
  const counted = instrumentFetch(inner, recorder);

  const got = await withOrigin('fn:getLaunch', () => counted('https://api.github.com/repos/a/b/pulls/1'));
  assert.equal(got, answer, 'the same answer');
  await withOrigin('fn:getLaunch', () => counted('https://api.github.com/repos/a/c/pulls/2'));
  await withOrigin('page:/', () => withOrigin('fn:getShell', () => counted('https://api.github.com/user')), { probe: true });
  const failing = instrumentFetch((async () => Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch, recorder);
  await assert.rejects(withOrigin('job:metrics', () => failing('https://bsky.social/xrpc/app.bsky.feed.getPosts', { method: 'get' })), /fetch failed/);
  await recorder.flush();

  const pulls = calls.find((c) => c.endpoint === '/repos/:owner/:repo/pulls/:n')!;
  assert.equal(pulls.calls, 2);
  assert.equal(pulls.origin, 'fn:getLaunch');
  assert.equal(pulls.hour, '2026-10-28T14:00:00.000Z');
  assert.equal(pulls.bytes, 22);
  assert.equal(pulls.quotaPeak, 0.1);
  assert.equal(calls.find((c) => c.endpoint === '/user')?.origin, PROBE_ORIGIN, 'a probe stays a probe');
  const gone = calls.find((c) => c.provider === 'bluesky')!;
  assert.deepEqual([gone.status, gone.method, gone.origin], [0, 'GET', 'job:metrics']);
});

test('counts that could not be written are kept for the next flush', async () => {
  const { store, calls, timings, state } = fakeStore();
  const recorder = new TelemetryRecorder({ process: 'test', store: () => store });
  recorder.call({ origin: 'other', provider: 'github', method: 'GET', endpoint: '/', status: 200, ms: 10, bytes: 0 });
  recorder.timing({ kind: 'job', name: 'round', outcome: 'ok', ms: 2800 });
  state.failing = true;
  const quietError = console.error;
  console.error = () => {};
  try {
    await recorder.flush();
  } finally {
    console.error = quietError;
  }
  recorder.call({ origin: 'other', provider: 'github', method: 'GET', endpoint: '/', status: 200, ms: 10, bytes: 0 });
  state.failing = false;
  await recorder.flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.calls, 2);
  assert.equal(timings[0]?.count, 1);
  await recorder.flush();
  assert.equal(calls.length, 1, 'nothing written twice');
});

test('time() records the outcome and passes the result or the error through', async () => {
  const { store, timings } = fakeStore();
  const recorder = new TelemetryRecorder({ process: 'test', store: () => store });
  assert.equal(await recorder.time('fn', 'getLaunch', async () => 7), 7);
  await assert.rejects(recorder.time('fn', 'getLaunch', async () => Promise.reject(new Error('no'))), /no/);
  await recorder.flush();
  assert.deepEqual(timings.map((t) => [t.name, t.outcome, t.count]).sort(), [
    ['getLaunch', 'error', 1],
    ['getLaunch', 'ok', 1],
  ]);
});

test('flags are off unless named, and a misspelt one is refused', () => {
  const flags = Flags.fromEnv({ SHIPCAST_FLAGS: 'bullmq, publishing-service' });
  assert.equal(flags.on('bullmq'), true);
  assert.equal(flags.on('realtime-ui'), false);
  assert.equal(flags.list()['publishing-service'], true);
  assert.equal(Flags.fromEnv({}).on('bullmq'), false);
  assert.throws(() => Flags.fromEnv({ SHIPCAST_FLAGS: 'bulmq' }), /unknown bulmq/);
});
