import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GitHubError, GitHubRest } from '../src/index.ts';

interface Seen {
  url: string;
  headers: Record<string, string>;
}

/** A fetch that answers from a list and records the requests. */
function fakeFetch(responses: Response[], seen: Seen[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
    const next = responses.shift();
    if (!next) throw new Error('unexpected request');
    return next;
  }) as typeof fetch;
}

const rawEvents = [
  {
    id: '5',
    type: 'ReleaseEvent',
    created_at: '2026-10-24T10:00:00Z',
    repo: { name: 'yeyo11/claudio' },
    payload: {
      action: 'published',
      release: { tag_name: 'v0.9.0', prerelease: false, draft: false, html_url: 'https://github.com/yeyo11/claudio/releases/tag/v0.9.0' },
    },
  },
  { id: '4', type: 'PushEvent', created_at: '2026-10-24T09:00:00Z', repo: { name: 'yeyo11/claudio' }, payload: {} },
  { id: '3', type: 'PublicEvent', created_at: '2026-10-24T08:00:00Z', repo: { name: 'yeyo11/new' }, payload: {} },
  {
    id: '2',
    type: 'ReleaseEvent',
    created_at: '2026-10-24T07:00:00Z',
    repo: { name: 'yeyo11/x' },
    payload: { action: 'created', release: { tag_name: 'v1', prerelease: false, draft: false, html_url: 'u' } },
  },
];

test('events are fetched with auth, reduced to releases and repos made public, and the etag kept', async () => {
  const seen: Seen[] = [];
  const github = new GitHubRest({
    token: 't0k3n',
    fetch: fakeFetch([new Response(JSON.stringify(rawEvents), { headers: { etag: 'W/"abc"' } })], seen),
  });
  const page = await github.userEvents('yeyo11');
  assert.equal(page.notModified, false);
  assert.ok(!page.notModified);
  assert.equal(page.etag, 'W/"abc"');
  assert.deepEqual(
    page.events.map((e) => `${e.type} ${e.repo}${e.type === 'release' ? ` ${e.tag}` : ''}`),
    ['release yeyo11/claudio v0.9.0', 'public yeyo11/new'],
    'pushes and non-published release actions are dropped',
  );
  assert.equal(seen[0]?.url, 'https://api.github.com/users/yeyo11/events/public?per_page=100');
  assert.equal(seen[0]?.headers.authorization, 'Bearer t0k3n');
  assert.equal(seen[0]?.headers['if-none-match'], undefined);
});

test('a conditional request that comes back 304 is reported as not modified', async () => {
  const seen: Seen[] = [];
  const github = new GitHubRest({ token: 't', fetch: fakeFetch([new Response(null, { status: 304 })], seen) });
  assert.deepEqual(await github.userEvents('yeyo11', 'W/"abc"'), { notModified: true });
  assert.equal(seen[0]?.headers['if-none-match'], 'W/"abc"');
});

test('a file is read raw at a ref; a missing one is undefined; other errors throw', async () => {
  const seen: Seen[] = [];
  const github = new GitHubRest({
    token: 't',
    fetch: fakeFetch(
      [new Response('enabled: true\n'), new Response('Not Found', { status: 404 }), new Response('', { status: 500 })],
      seen,
    ),
  });
  assert.equal(await github.fileAt('yeyo11/claudio', '.github/launch.yml', 'v0.9.0'), 'enabled: true\n');
  assert.equal(seen[0]?.url, 'https://api.github.com/repos/yeyo11/claudio/contents/.github/launch.yml?ref=v0.9.0');
  assert.equal(seen[0]?.headers.accept, 'application/vnd.github.raw+json');
  assert.equal(await github.fileAt('yeyo11/claudio', '.github/launch.yml', 'v0.1.0'), undefined);
  await assert.rejects(github.fileAt('yeyo11/claudio', '.github/launch.yml', 'v0.2.0'), (e) => e instanceof GitHubError && e.status === 500);
});
