import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConnectorError, HttpClient, type HttpCall, type HttpClientOptions, MemoryEtagCache, type QuotaReport, quotaOf, retryAfterMs } from '../src/index.ts';

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string>;
  signal: AbortSignal | undefined;
}

/** A fetch answering in turn from `answers` (the last repeats), and a clock that only sleeps move */
function harness(answers: Array<Response | Error | 'hang'>, options: Partial<HttpClientOptions> = {}) {
  const seen: Seen[] = [];
  const waits: number[] = [];
  const calls: HttpCall[] = [];
  const clock = { now: Date.parse('2026-10-28T10:00:00Z') };
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ method: init?.method ?? 'GET', url: String(input), headers: (init?.headers ?? {}) as Record<string, string>, signal: init?.signal ?? undefined });
    const answer = answers[Math.min(seen.length - 1, answers.length - 1)]!;
    if (answer === 'hang') {
      // AbortSignal.timeout's timer does not hold the process open; a real socket would
      const open = setInterval(() => undefined, 1000);
      return new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener('abort', () => {
          clearInterval(open);
          reject(init.signal?.reason);
        }),
      );
    }
    if (answer instanceof Error) throw answer;
    // A fresh copy, not a clone: a clone's body is a tee tied to the original
    return new Response(answer.status === 304 ? null : await answer.clone().arrayBuffer(), { status: answer.status, headers: answer.headers });
  }) as typeof fetch;
  const client = new HttpClient({
    network: 'testnet',
    fetch: fake,
    baseUrl: 'https://api.test/',
    sleep: async (ms) => {
      waits.push(ms);
      clock.now += ms;
    },
    now: () => clock.now,
    random: () => 0.5,
    onCall: (call) => calls.push(call),
    ...options,
  });
  return { client, seen, waits, calls, clock };
}

test('a GET retries 503s with exponential backoff and returns the answer that worked', async () => {
  const { client, seen, waits, calls } = harness([new Response('busy', { status: 503 }), new Response('busy', { status: 503 }), Response.json({ ok: 1 })]);
  assert.deepEqual(await client.json('/things'), { ok: 1 });
  assert.equal(seen.length, 3);
  // base 500, equal jitter at random 0.5: 375, then 750
  assert.deepEqual(waits, [375, 750]);
  assert.deepEqual(
    calls.map((c) => [c.attempt, c.status, c.fromCache]),
    [
      [1, 503, false],
      [2, 503, false],
      [3, 200, false],
    ],
  );
});

test('Retry-After in seconds and as an HTTP date is honoured', async () => {
  const seconds = harness([new Response('', { status: 429, headers: { 'retry-after': '7' } }), new Response('fine')]);
  assert.equal(await seconds.client.text('/a'), 'fine');
  assert.deepEqual(seconds.waits, [7000]);

  const date = harness([new Response('', { status: 503, headers: { 'retry-after': 'Wed, 28 Oct 2026 10:00:12 GMT' } }), new Response('fine')]);
  assert.equal(await date.client.text('/a'), 'fine');
  assert.deepEqual(date.waits, [12_000]);

  assert.equal(retryAfterMs(new Headers({ 'retry-after': 'Wed, 28 Oct 2026 09:00:00 GMT' }), Date.parse('2026-10-28T10:00:00Z')), 0, 'a date in the past is no wait');
  assert.equal(retryAfterMs(new Headers({ 'retry-after': 'soon' })), undefined);
});

test('a Retry-After longer than the cap is not waited out: the 429 comes back as an error', async () => {
  const { client, seen, waits } = harness([new Response('slow down', { status: 429, headers: { 'retry-after': '3600' } })]);
  await assert.rejects(client.json('/a'), (error: unknown) => error instanceof ConnectorError && error.status === 429 && error.retryable);
  assert.equal(seen.length, 1);
  assert.deepEqual(waits, []);
});

test('the attempts and the total wait are capped', async () => {
  const capped = harness([new Response('', { status: 502 })], { retry: { attempts: 4 } });
  assert.equal((await capped.client.request('/a')).status, 502);
  assert.equal(capped.seen.length, 4);

  const total = harness([new Response('', { status: 502 })], { retry: { attempts: 10, maxTotalMs: 1000 } });
  assert.equal((await total.client.request('/a')).status, 502);
  assert.deepEqual(total.waits, [375], 'the next wait, 750, would pass the 1000 ms budget');
});

test('a POST is not retried, unless it carries an idempotency key or asks for it', async () => {
  const plain = harness([new Response('', { status: 503 }), new Response('ok')]);
  await assert.rejects(plain.client.ok('/posts', { method: 'POST', body: '{}' }), (error: unknown) => error instanceof ConnectorError && error.status === 503);
  assert.equal(plain.seen.length, 1);

  const keyed = harness([new Response('', { status: 503 }), new Response('ok')]);
  await keyed.client.ok('/posts', { method: 'POST', body: '{}', idempotencyKey: 'launch-7-mastodon' });
  assert.equal(keyed.seen.length, 2);
  assert.equal(keyed.seen[1]?.headers['idempotency-key'], 'launch-7-mastodon');

  const forced = harness([new Response('', { status: 504 }), new Response('ok')]);
  await forced.client.ok('/search', { method: 'POST', retry: true });
  assert.equal(forced.seen.length, 2);

  const off = harness([new Response('', { status: 503 })]);
  assert.equal((await off.client.request('/a', { retry: false })).status, 503);
  assert.equal(off.seen.length, 1);
});

test('400s and 500s are not retried', async () => {
  for (const status of [400, 401, 404, 500]) {
    const { client, seen } = harness([new Response('no', { status })]);
    assert.equal((await client.request('/a')).status, status);
    assert.equal(seen.length, 1);
  }
});

test('every call times out; a timed-out GET is retried, then fails as a retryable ConnectorError', async () => {
  const { client, seen, calls } = harness(['hang'], { timeoutMs: 20, retry: { attempts: 2 } });
  await assert.rejects(client.json('/slow'), (error: unknown) => {
    assert.ok(error instanceof ConnectorError);
    assert.match(error.message, /^testnet: GET \/slow: timed out after 20 ms$/);
    assert.equal(error.status, undefined);
    assert.equal(error.retryable, true);
    return true;
  });
  assert.equal(seen.length, 2);
  assert.deepEqual(
    calls.map((c) => c.status),
    [0, 0],
  );
});

test('a per-call timeout overrides the client default, and a timed-out POST is not retryable', async () => {
  const { client, seen } = harness(['hang'], { timeoutMs: 60_000 });
  const started = performance.now();
  await assert.rejects(client.ok('/posts', { method: 'POST', timeoutMs: 15, what: 'publish' }), (error: unknown) => {
    assert.ok(error instanceof ConnectorError);
    assert.equal(error.message, 'testnet: publish: timed out after 15 ms');
    assert.equal(error.retryable, false, 'it may have gone through');
    return true;
  });
  assert.ok(performance.now() - started < 5000);
  assert.equal(seen.length, 1);
});

test('network errors are retried on a GET and named in the error', async () => {
  const flaky = harness([new TypeError('fetch failed'), Response.json([1])]);
  assert.deepEqual(await flaky.client.json('/a'), [1]);
  assert.equal(flaky.seen.length, 2);

  const down = harness([new TypeError('fetch failed')], { retry: { attempts: 2 } });
  await assert.rejects(down.client.text('/a'), /testnet: GET \/a: could not reach the network: fetch failed/);
});

test('the caller aborting stops the call with its own reason, and no retry follows', async () => {
  const { client, seen } = harness(['hang']);
  const controller = new AbortController();
  const pending = client.json('/a', { signal: controller.signal });
  setTimeout(() => controller.abort(new Error('the job was cancelled')), 5);
  await assert.rejects(pending, /the job was cancelled/);
  assert.equal(seen.length, 1);

  const already = harness([new Response('x')]);
  await assert.rejects(already.client.text('/a', { signal: AbortSignal.abort(new Error('gone')) }), /gone/);
  assert.equal(already.seen.length, 0);
});

test('the caller signal reaches fetch combined with the timeout', async () => {
  const { client, seen } = harness([new Response('x')]);
  const controller = new AbortController();
  await client.text('/a', { signal: controller.signal });
  const signal = seen[0]?.signal;
  assert.ok(signal);
  assert.notEqual(signal, controller.signal);
  assert.equal(signal.aborted, false);
});

test('a GET with an ETag cache sends If-None-Match and answers a 304 from the cache', async () => {
  const etags = new MemoryEtagCache();
  const { client, seen, calls } = harness([Response.json({ v: 1 }, { headers: { etag: '"abc"' } }), new Response(null, { status: 304, headers: { etag: '"abc"' } })], { etags, headers: { authorization: 'Bearer one' } });
  const first = await client.request('/repo');
  assert.equal(first.fromCache, false);
  assert.deepEqual(await first.json(), { v: 1 });
  assert.equal(seen[0]?.headers['if-none-match'], undefined);

  const second = await client.request('/repo');
  assert.equal(seen[1]?.headers['if-none-match'], '"abc"');
  assert.equal(second.status, 200);
  assert.equal(second.fromCache, true);
  assert.deepEqual(await second.json(), { v: 1 });
  assert.equal(second.headers.get('content-type'), 'application/json');
  assert.deepEqual(
    calls.map((c) => [c.status, c.fromCache]),
    [
      [200, false],
      [304, true],
    ],
  );
  assert.deepEqual(await client.json('/repo'), { v: 1 }, 'json() reads the cached body too');
});

test('the ETag cache is keyed by credential, and left alone for other methods or when turned off', async () => {
  const etags = new MemoryEtagCache();
  const answers = [Response.json({ who: 'a' }, { headers: { etag: '"a"' } })];
  await harness(answers, { etags, headers: { authorization: 'Bearer a' } }).client.text('/me');
  const other = harness([Response.json({ who: 'b' })], { etags, headers: { authorization: 'Bearer b' } });
  await other.client.text('/me');
  assert.equal(other.seen[0]?.headers['if-none-match'], undefined, 'another account never gets the first one’s answer');

  const same = harness([Response.json({})], { etags, headers: { authorization: 'Bearer a' } });
  await same.client.text('/me', { etagCache: false });
  await same.client.ok('/me', { method: 'PUT', body: '{}' });
  assert.equal(same.seen[0]?.headers['if-none-match'], undefined);
  assert.equal(same.seen[1]?.headers['if-none-match'], undefined);
  assert.equal(etags.entries.size, 1);
});

test('the quota of every answer is reported, with the reset', async () => {
  const quotas: QuotaReport[] = [];
  const { client } = harness([new Response('{}', { headers: { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '1000', 'x-ratelimit-reset': '1793181600' } })], {
    onQuota: (q) => quotas.push(q),
  });
  await client.json('/rate');
  assert.deepEqual(quotas, [{ used: 0.8, limit: 5000, reset: 1793181600_000, provider: 'testnet', url: 'https://api.test/rate', status: 200 }]);
});

test('quotaOf reads the reset as epoch seconds, seconds from now or a date', () => {
  const now = Date.parse('2026-10-28T10:00:00Z');
  const of = (reset: string) => quotaOf(new Headers({ 'ratelimit-limit': '100', 'ratelimit-remaining': '50', 'ratelimit-reset': reset }), now)?.reset;
  assert.equal(of('1793181600'), 1793181600_000);
  assert.equal(of('60'), now + 60_000);
  assert.equal(of('2026-10-28T10:05:00.000Z'), now + 300_000);
  assert.equal(of('never'), undefined);
});

test('a non-2xx becomes a ConnectorError shaped like the json() helper’s', async () => {
  const long = 'x'.repeat(500);
  const { client } = harness([new Response(long, { status: 422 })]);
  await assert.rejects(client.json('/posts', { method: 'POST', what: 'publish' }), (error: unknown) => {
    assert.ok(error instanceof ConnectorError);
    assert.equal(error.network, 'testnet');
    assert.equal(error.status, 422);
    assert.equal(error.message, `testnet: publish: 422 ${'x'.repeat(300)}`);
    assert.equal(error.retryable, false);
    return true;
  });

  const notJson = harness([new Response('<html>')]);
  await assert.rejects(notJson.client.json('/a'), /testnet: GET \/a: the answer is not JSON/);
});

test('client headers merge with the call’s, lower-cased, the call winning', async () => {
  const { client, seen } = harness([new Response('')], { headers: { Authorization: 'Bearer t', 'User-Agent': 'shipcast' } });
  await client.ok('https://other.test/x?y=1', { headers: { 'user-agent': 'mine' } });
  assert.equal(seen[0]?.url, 'https://other.test/x?y=1', 'an absolute URL ignores the base');
  assert.deepEqual(seen[0]?.headers, { authorization: 'Bearer t', 'user-agent': 'mine' });
});

test('without an injected fetch, the global one is read at call time', async () => {
  const original = globalThis.fetch;
  const client = new HttpClient({ network: 'testnet' });
  let counted = 0;
  globalThis.fetch = (async () => {
    counted++;
    return new Response('wrapped');
  }) as typeof fetch;
  try {
    assert.equal(await client.text('https://api.test/a'), 'wrapped');
    assert.equal(counted, 1);
  } finally {
    globalThis.fetch = original;
  }
});
