import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import { MemoryEtagCache } from '@shipcast/connectors';
import { GitHubApp, GitHubRest, type FileCache } from '../src/index.ts';

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string>;
}

/** GitHub as far as ETags go: each path has a body and a version; a matching If-None-Match is a 304 */
function etagGitHub(bodies: Record<string, { body: string; etag: string }>, seen: Seen[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const method = init?.method ?? 'GET';
    seen.push({ method, url: url.href, headers });
    if (method !== 'GET') return Response.json({ ok: true });
    const found = bodies[url.pathname];
    if (!found) return new Response('{"message":"Not Found"}', { status: 404 });
    if (headers['if-none-match'] === found.etag) return new Response(null, { status: 304, headers: { etag: found.etag } });
    return new Response(found.body, { status: 200, headers: { etag: found.etag, 'content-type': 'application/json' } });
  }) as typeof fetch;
}

test('every GET is conditional: the second read sends the ETag and a 304 answers with the cached body', async () => {
  const seen: Seen[] = [];
  const bodies = { '/repos/yeyo11/launches/pulls/7': { body: JSON.stringify({ state: 'open', merged: false }), etag: 'W/"a"' } };
  const github = new GitHubRest({ token: 't1', fetch: etagGitHub(bodies, seen), etags: new MemoryEtagCache() });
  assert.equal(await github.pullRequestState('yeyo11/launches', 7), 'open');
  assert.equal(await github.pullRequestState('yeyo11/launches', 7), 'open', 'the 304 is answered with what was cached');
  assert.equal(seen[0]?.headers['if-none-match'], undefined);
  assert.equal(seen[1]?.headers['if-none-match'], 'W/"a"');

  bodies['/repos/yeyo11/launches/pulls/7'] = { body: JSON.stringify({ state: 'closed', merged: true }), etag: 'W/"b"' };
  assert.equal(await github.pullRequestState('yeyo11/launches', 7), 'merged', 'a changed resource is a 200 and replaces the entry');
});

test('without an ETag cache nothing changes: no validator is sent', async () => {
  const seen: Seen[] = [];
  const github = new GitHubRest({ token: 't1', fetch: etagGitHub({ '/repos/a/b/pulls/1': { body: '{"state":"open"}', etag: '"x"' } }, seen) });
  await github.pullRequestState('a/b', 1);
  await github.pullRequestState('a/b', 1);
  assert.ok(seen.every((s) => s.headers['if-none-match'] === undefined));
});

test('two tokens never share an answer, and raw and JSON reads of one URL are two entries', async () => {
  const seen: Seen[] = [];
  const etags = new MemoryEtagCache();
  const bodies = { '/repos/a/b/contents/x.md': { body: 'hello', etag: '"1"' } };
  const one = new GitHubRest({ token: 'first', fetch: etagGitHub(bodies, seen), etags });
  const two = new GitHubRest({ token: 'second', fetch: etagGitHub(bodies, seen), etags });
  assert.equal(await one.fileAt('a/b', 'x.md', 'HEAD'), 'hello');
  assert.equal(await two.fileAt('a/b', 'x.md', 'HEAD'), 'hello');
  assert.equal(seen[1]?.headers['if-none-match'], undefined, "the second token does not ride on the first's entry");
  await one.pathExists('a/b', 'x.md', 'HEAD');
  assert.equal(seen[2]?.headers['if-none-match'], undefined, 'the JSON read is not the raw one');
  assert.equal(etags.entries.size, 3);
});

test("writes are never conditional, and the events poll keeps its own validator", async () => {
  const seen: Seen[] = [];
  const etags = new MemoryEtagCache();
  const github = new GitHubRest({ token: 't', fetch: etagGitHub({ '/users/yeyo11/events/public': { body: '[]', etag: '"e"' } }, seen), etags });
  assert.deepEqual(await github.userEvents('yeyo11', '"e"'), { notModified: true }, 'the caller asked for the 304 itself');
  await github.updateFile('a/b', 'main', 'x.md', 'x', 'edit').catch(() => undefined);
  assert.equal(etags.entries.size, 0);
  assert.ok(seen.filter((s) => s.method !== 'GET').every((s) => s.headers['if-none-match'] === undefined));
});

test("an App's answers are keyed by its installation, so a token minted an hour later still gets the 304", async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const seen: Seen[] = [];
  let minted = 0;
  const now = Date.parse('2026-10-28T12:00:00Z');
  const base = etagGitHub({ '/repos/yeyo11/launches/pulls/3': { body: '{"state":"open","merged":false}', etag: '"p"' } }, seen);
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === '/repos/yeyo11/launches/installation') return Response.json({ id: 77, account: { login: 'yeyo11' }, repository_selection: 'all', permissions: {} });
    if (path === '/app/installations/77/access_tokens') return Response.json({ token: `ghs_${++minted}`, expires_at: new Date(now + 3600_000).toISOString() }, { status: 201 });
    return base(input, init);
  }) as typeof fetch;
  const etags = new MemoryEtagCache();
  const app = new GitHubApp({ appId: '1', privateKey: pem, account: () => 'yeyo11/launches', fetch: fetchImpl, now: () => now, etags });
  const github = new GitHubRest({ token: app, fetch: fetchImpl, etags });
  await github.pullRequestState('yeyo11/launches', 3);
  app.invalidate();
  await github.pullRequestState('yeyo11/launches', 3);
  const reads = seen.filter((s) => s.url.endsWith('/pulls/3'));
  assert.equal(minted, 2, 'a new token was minted');
  assert.notEqual(reads[0]?.headers.authorization, reads[1]?.headers.authorization);
  assert.equal(reads[1]?.headers['if-none-match'], '"p"');
});

/** A FileCache that keeps every HEAD read of the launches repo */
class Files implements FileCache {
  readonly kept = new Map<string, string>();
  forgotten: Array<{ repo: string; paths: readonly string[] | undefined }> = [];
  keeps(repo: string, _path: string, ref: string): boolean {
    return repo === 'yeyo11/launches' && ref === 'HEAD';
  }
  async get(repo: string, path: string, ref: string) {
    return this.kept.get(`${repo}/${path}@${ref}`);
  }
  async set(repo: string, path: string, ref: string, text: string) {
    this.kept.set(`${repo}/${path}@${ref}`, text);
  }
  async forget(repo: string, paths?: readonly string[]) {
    this.forgotten.push({ repo, paths });
    if (!paths) this.kept.clear();
    else for (const p of paths) this.kept.delete(`${repo}/${p}@HEAD`);
  }
}

test('a kept file is read from GitHub once, and forgotten by the client’s own commits and merges', async () => {
  const seen: Seen[] = [];
  const files = new Files();
  const github = new GitHubRest({ token: 't', fetch: etagGitHub({ '/repos/yeyo11/launches/contents/brand.yml': { body: 'id: me', etag: '"b"' } }, seen), files });
  assert.equal(await github.fileAt('yeyo11/launches', 'brand.yml', 'HEAD'), 'id: me');
  assert.equal(await github.fileAt('yeyo11/launches', 'brand.yml', 'HEAD'), 'id: me');
  assert.equal(seen.length, 1, 'the second read never left the process');
  assert.equal(await github.fileAt('yeyo11/launches', 'missing.yml', 'HEAD'), undefined);
  assert.equal(files.kept.has('yeyo11/launches/missing.yml@HEAD'), false, 'an absent file is not kept');

  await github.updateFile('yeyo11/launches', 'main', 'projects.yml', 'x: 1', 'edit');
  assert.deepEqual(files.forgotten.at(-1), { repo: 'yeyo11/launches', paths: ['projects.yml'] });
  await github.mergePullRequest('yeyo11/launches', 3, 'merge');
  assert.deepEqual(files.forgotten.at(-1), { repo: 'yeyo11/launches', paths: undefined }, 'a merge forgets the whole repo');
});
