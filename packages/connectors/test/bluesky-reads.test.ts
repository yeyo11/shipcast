import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Bluesky, ConnectorError, failureText } from '../src/index.ts';
import { fakeFetch, sequence, type Call } from './fake.ts';

/*
 * The AppView's reads after the hourly reads lost Bluesky's numbers to a bare "fetch failed"
 * (2026-10-30 to 2026-11-01): a network error is said with its cause, tried again, then asked of
 * api.bsky.app, and a batch that still fails costs only its own posts.
 */

/** Node's fetch failing as undici does: a TypeError whose cause holds the reason and its code */
function fetchFailed(code: string, message: string): TypeError {
  return new TypeError('fetch failed', { cause: Object.assign(new Error(message), { code }) });
}

const PUBLIC = 'GET https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts';
const DIRECT = 'GET https://api.bsky.app/xrpc/app.bsky.feed.getPosts';
const uri = (n: number) => `at://did:plc:abc/app.bsky.feed.post/p${n}`;
const posts = (url: string) => ({ posts: new URL(url).searchParams.getAll('uris').map((u) => ({ uri: u, likeCount: 3 })) });

/** A fake network whose answers can read the URL asked for */
function network(rules: Array<[string, (url: string) => Response]>, calls: Call[]): typeof fetch {
  let last = '';
  const inner = fakeFetch(
    rules.map(([key, answer]) => [key, () => answer(last)]),
    calls,
  );
  return ((input: string | URL | Request, init?: RequestInit) => {
    last = String(input);
    return inner(input, init);
  }) as typeof fetch;
}

const quick = { baseMs: 1 };

test('a failure is said with its cause and code, each once', () => {
  assert.equal(failureText(fetchFailed('UND_ERR_SOCKET', 'other side closed')), 'fetch failed: other side closed (UND_ERR_SOCKET)');
  assert.equal(failureText(fetchFailed('EAI_AGAIN', 'getaddrinfo EAI_AGAIN public.api.bsky.app')), 'fetch failed: getaddrinfo EAI_AGAIN public.api.bsky.app', 'a code the message says already');
  const eyeballs = Object.assign(new AggregateError([new Error('connect ETIMEDOUT 1.2.3.4:443'), new Error('connect ENETUNREACH ::1:443')], ''), { code: 'ETIMEDOUT' });
  assert.equal(failureText(new TypeError('fetch failed', { cause: eyeballs })), 'fetch failed: connect ETIMEDOUT 1.2.3.4:443, connect ENETUNREACH ::1:443', 'happy eyeballs: every address’s error');
  const wrapped = new ConnectorError('Bluesky', 'metrics: could not reach the network: fetch failed: other side closed');
  wrapped.cause = fetchFailed('UND_ERR_SOCKET', 'other side closed');
  assert.equal(failureText(wrapped), 'Bluesky: metrics: could not reach the network: fetch failed: other side closed (UND_ERR_SOCKET)', 'the causes add only what the message lacks');
  const outer = new Error('read failed', { cause: new ConnectorError('Bluesky', 'metrics: 503 busy', 503) });
  assert.equal(failureText(outer), 'read failed: Bluesky: metrics: 503 busy', 'Shipcast’s own codes (upstream) are not a network’s');
  assert.equal(failureText('plain'), 'plain');
});

test('Bluesky metrics: a network error is tried again on the same host', async () => {
  const calls: Call[] = [];
  const answers = sequence(
    () => {
      throw fetchFailed('ECONNRESET', 'read ECONNRESET');
    },
    () => Response.json({ posts: [{ uri: uri(1), likeCount: 3 }] }),
  );
  const bluesky = new Bluesky({ identifier: 'x', appPassword: 'y', retry: quick, fetch: fakeFetch([[PUBLIC, answers]], calls) });
  const read = await bluesky.metricsMany([uri(1)]);
  assert.deepEqual(read.get(uri(1)), { likes: 3, reposts: 0, replies: 0, quotes: 0, saves: 0 });
  assert.equal(read.problems, undefined, 'a retry that worked is nothing to report');
  assert.equal(calls.length, 2);
});

test('Bluesky metrics: the public host never answering, they are read from api.bsky.app, and the log says why', async () => {
  const calls: Call[] = [];
  const fetch = network(
    [
      [
        PUBLIC,
        () => {
          throw fetchFailed('UND_ERR_CONNECT_TIMEOUT', 'Connect Timeout Error (attempted address: public.api.bsky.app:443, timeout: 10000ms)');
        },
      ],
      [DIRECT, (url) => Response.json(posts(url))],
    ],
    calls,
  );
  const read = await new Bluesky({ identifier: 'x', appPassword: 'y', retry: quick, fetch }).metricsMany([uri(1), uri(2)]);
  assert.equal(read.get(uri(2))?.likes, 3);
  assert.deepEqual(
    calls.map((c) => new URL(c.url).host),
    ['public.api.bsky.app', 'public.api.bsky.app', 'public.api.bsky.app', 'api.bsky.app'],
    'three tries, then the AppView itself',
  );
  assert.deepEqual(read.problems, [
    'metrics read from api.bsky.app: public.api.bsky.app gave no answer (could not reach the network: fetch failed: Connect Timeout Error (attempted address: public.api.bsky.app:443, timeout: 10000ms) (UND_ERR_CONNECT_TIMEOUT))',
  ]);
});

test('Bluesky metrics: neither AppView answering, the read fails naming both reasons', async () => {
  const fetch = fakeFetch(
    [
      [
        PUBLIC,
        () => {
          throw fetchFailed('UND_ERR_SOCKET', 'other side closed');
        },
      ],
      [
        DIRECT,
        () => {
          throw fetchFailed('EAI_AGAIN', 'getaddrinfo EAI_AGAIN api.bsky.app');
        },
      ],
    ],
    [],
  );
  await assert.rejects(new Bluesky({ identifier: 'x', appPassword: 'y', retry: quick, fetch }).metricsMany([uri(1)]), (error: unknown) => {
    assert.ok(error instanceof ConnectorError);
    assert.equal(
      error.message,
      'Bluesky: metrics: no AppView answered: public.api.bsky.app gave no answer (could not reach the network: fetch failed: other side closed (UND_ERR_SOCKET)); api.bsky.app: could not reach the network: fetch failed: getaddrinfo EAI_AGAIN api.bsky.app',
    );
    assert.equal(error.retryable, true);
    return true;
  });
});

test('Bluesky metrics: an HTTP answer is the AppView’s word, neither retried nor asked elsewhere', async () => {
  const calls: Call[] = [];
  const fetch = fakeFetch([[PUBLIC, () => new Response('{"error":"InvalidRequest"}', { status: 400 })]], calls);
  await assert.rejects(new Bluesky({ identifier: 'x', appPassword: 'y', retry: quick, fetch }).metricsMany([uri(1)]), /Bluesky: metrics: 400 \{"error":"InvalidRequest"\}/);
  assert.equal(calls.length, 1);
});

test('Bluesky metrics: a batch that fails costs only its own posts', async () => {
  const calls: Call[] = [];
  const uris = Array.from({ length: 30 }, (_, n) => uri(n));
  const fetch = network(
    [
      [
        'GET https://',
        (url) => {
          // The second batch (the last five posts) never gets an answer, from either host
          if (new URL(url).searchParams.getAll('uris').includes(uri(29))) throw fetchFailed('ECONNRESET', 'read ECONNRESET');
          return Response.json(posts(url));
        },
      ],
    ],
    calls,
  );
  const read = await new Bluesky({ identifier: 'x', appPassword: 'y', retry: quick, fetch }).metricsMany(uris);
  assert.equal(read.size, 25, 'the first batch still counts');
  assert.equal(read.has(uri(29)), false);
  assert.equal(read.problems?.length, 1);
  assert.match(read.problems![0]!, /^5 of 30 posts not read: Bluesky: metrics: no AppView answered: public\.api\.bsky\.app gave no answer \(.*read ECONNRESET\); api\.bsky\.app: .*read ECONNRESET$/);
});

test('Bluesky metrics: a custom AppView has no fallback unless one is named', async () => {
  const calls: Call[] = [];
  const fetch = fakeFetch(
    [
      [
        'GET https://appview.example/',
        () => {
          throw fetchFailed('ECONNREFUSED', 'connect ECONNREFUSED 10.0.0.1:443');
        },
      ],
    ],
    calls,
  );
  await assert.rejects(
    new Bluesky({ identifier: 'x', appPassword: 'y', retry: quick, fetch, appView: 'https://appview.example' }).metricsMany([uri(1)]),
    /Bluesky: metrics: could not reach the network: fetch failed: connect ECONNREFUSED 10\.0\.0\.1:443$/,
  );
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => c.url.startsWith('https://appview.example/')));
});
