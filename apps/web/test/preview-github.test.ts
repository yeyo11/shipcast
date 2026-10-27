import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import { GitHubRest } from '@shipcast/engine';
import { memoryRegistry } from '@shipcast/engine/testing';
import { createRuntime, MemoryStore } from '@shipcast/runtime';
import { fakeNetworks, previewGitHubFetch } from '../src/server/preview.server.ts';

/**
 * GitHub for the reads a write starts with (the open pull requests, a branch's head, a commit's
 * tree, a file's sha); a write that reaches it is a test failure, since a preview must never make one.
 */
function readsOnly(seen: string[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? 'GET';
    seen.push(`${method} ${url.pathname}`);
    if (method !== 'GET') throw new Error(`a preview wrote to GitHub: ${method} ${url.pathname}`);
    if (url.pathname === '/repos/yeyo11/launches/pulls') return Response.json([]);
    if (url.pathname.startsWith('/repos/yeyo11/launches/git/ref/heads/')) return Response.json({ object: { sha: 'base' } });
    if (url.pathname.startsWith('/repos/yeyo11/launches/git/commits/')) return Response.json({ tree: { sha: 'tree' } });
    if (url.pathname === '/repos/yeyo11/launches/contents/brand.yml') return new Response('{"message":"Not Found"}', { status: 404 });
    throw new Error(`unexpected ${method} ${url.pathname}`);
  }) as typeof fetch;
}

test('the switch only works on a plain-HTTP copy', () => {
  assert.equal(fakeNetworks({ SHIPCAST_PREVIEW_FAKE_NETWORKS: '1', SHIPCAST_APP_TLS: 'off' }), true);
  assert.equal(fakeNetworks({ SHIPCAST_PREVIEW_FAKE_NETWORKS: '1' }), false, 'production serves TLS');
});

test('on a preview a drafts pull request, a commit, brand.yml and a merge are dry runs that still answer', async () => {
  const seen: string[] = [];
  const github = new GitHubRest({ token: 't', fetch: previewGitHubFetch(readsOnly(seen)) });

  const pr = await github.openPullRequest({
    repo: 'yeyo11/launches',
    branch: 'launch/claudio-v1',
    base: 'main',
    title: 'Launch claudio v1',
    body: 'Drafts',
    message: 'Drafts for claudio v1',
    files: [
      { path: 'launches/claudio/v1/bluesky.md', content: 'Hello' },
      { path: 'launches/claudio/v1/cover.png', bytes: new Uint8Array([1, 2, 3]) },
    ],
  });
  assert.deepEqual(pr, { number: 0, url: 'https://github.com/yeyo11/launches/pull/0', created: true });

  const commit = await github.commitToBranch('yeyo11/launches', 'main', 'Edit the article', [{ path: 'src/content/posts/en/a.md', content: 'x' }]);
  assert.match(commit.sha, /^[0-9a-f]{40}$/);

  await github.updateFile('yeyo11/launches', 'main', 'brand.yml', 'id: personal\n', 'chore: add brand.yml for Shipcast');
  assert.match((await github.mergePullRequest('yeyo11/launches', 12, 'Launch claudio v1 (#12)')).sha, /^[0-9a-f]{40}$/);

  assert.ok(
    seen.every((s) => s.startsWith('GET ')),
    'only reads reached GitHub',
  );
  assert.ok(seen.includes('GET /repos/yeyo11/launches/git/ref/heads/main'), 'the reads before a write are real');
});

test('a preview runtime pretends to write with its REST client while the App still mints real tokens', async () => {
  const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const minted: string[] = [];
  const real = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const key = `${init?.method ?? 'GET'} ${url.pathname}`;
    if (key === 'GET /users/yeyo11/installation') return Response.json({ id: 9, account: { login: 'yeyo11' }, repository_selection: 'all', permissions: {} });
    if (key === 'POST /app/installations/9/access_tokens') {
      minted.push(key);
      return Response.json({ token: 'ghs_t', expires_at: new Date(Date.now() + 3600_000).toISOString() }, { status: 201 });
    }
    if (key === 'GET /repos/yeyo11/launches/contents/brand.yml') return new Response('{"message":"Not Found"}', { status: 404 });
    throw new Error(`a preview wrote to GitHub: ${key}`);
  }) as typeof fetch;
  const runtime = await createRuntime({
    env: {
      SHIPCAST_DATABASE_URL: 'postgres://shipcast:x@127.0.0.1:5432/shipcast',
      SHIPCAST_GITHUB_APP_ID: '1',
      SHIPCAST_GITHUB_APP_SLUG: 'shipcast-test',
      SHIPCAST_GITHUB_APP_CLIENT_ID: 'Iv23app',
      SHIPCAST_GITHUB_APP_CLIENT_SECRET: 's',
      SHIPCAST_GITHUB_APP_PRIVATE_KEY: pem,
      SHIPCAST_ALLOWED_GITHUB: 'yeyo11',
    },
    root: '/repo',
    registry: await memoryRegistry(),
    secrets: new MemoryStore(),
    fetch: real,
    githubFetch: previewGitHubFetch(real),
    log: () => {},
  });
  // The onboarding's Commit brand.yml: a real read for the file's sha, a pretended write
  await runtime.github.updateFile('yeyo11/launches', 'main', 'brand.yml', 'id: personal\n', 'chore: add brand.yml for Shipcast');
  assert.deepEqual(minted, ['POST /app/installations/9/access_tokens'], 'the token for the read was minted for real');
});
