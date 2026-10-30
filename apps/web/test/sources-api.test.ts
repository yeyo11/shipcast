import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_UPLOAD_BYTES, type ReviewGitHub, type SourcesLaunchInput } from '@shipcast/engine';
import { memoryRegistry } from '@shipcast/engine/testing';
import { createApiToken, MemoryStore } from '@shipcast/runtime';
import { FailureLimiter, handleApi, openApiDocument, type ApiDeps } from '../src/server/api.ts';
import { sourcesRequest } from '../src/server/requests.ts';
import { readCapped, type SourcesApi } from '../src/server/sources-api.ts';

/* The routes of launches made from sources (launch-sources), with the work faked */

const unused = async (): Promise<never> => {
  throw new Error('the sources routes start no other work');
};

async function setup(sources?: SourcesApi) {
  const registry = await memoryRegistry();
  const secrets = new MemoryStore();
  const deps: ApiDeps = {
    registry,
    secrets,
    github: {} as ReviewGitHub,
    launchesRepo: 'yeyo11/launches',
    publicUrl: 'https://shipcast.example',
    limiter: new FailureLimiter(),
    jobs: async () => ({ jobs: [], next: null }),
    startLaunch: unused,
    approve: unused,
    startArticle: unused,
    startPublishing: unused,
    editing: unused,
    armSchedule: unused,
    comments: unused,
    checkComments: unused,
    redraftComment: unused,
    ...(sources && { sources }),
  };
  const token = (await createApiToken({ registry, secrets }, 'writer', ['read', 'write'])).token;
  return { deps, token };
}

const request = (path: string, token: string, body: BodyInit, type: string) =>
  new Request(`https://shipcast.example/api/v1${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': type }, body });

test('a launch made from sources is checked, then started as a job', async () => {
  const started: SourcesLaunchInput[] = [];
  const { deps, token } = await setup({
    start: async (input) => (started.push(input), { ok: true, job: 'job-9' }),
    upload: unused,
  });
  const body = { title: 'Why I self-host', lang: 'es', channels: ['bluesky', 'nowhere'], sources: [{ kind: 'text', text: 'mine' }, { kind: 'url', url: 'https://example.com' }, { kind: 'repo', repo: 'yeyo11/claudio', primary: true }] };
  const response = await handleApi(request('/launches/sources', token, JSON.stringify(body), 'application/json'), deps);
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { job: 'job-9' });
  assert.deepEqual(started[0], {
    title: 'Why I self-host',
    lang: 'es',
    channels: ['bluesky'],
    sources: [{ kind: 'text', text: 'mine' }, { kind: 'url', url: 'https://example.com' }, { kind: 'repo', repo: 'yeyo11/claudio', primary: true }],
  });

  const bad = await handleApi(request('/launches/sources', token, JSON.stringify({ ...body, sources: [{ kind: 'shell', command: 'rm' }] }), 'application/json'), deps);
  assert.equal(bad.status, 400);
});

test('with the flag off the routes answer that they are not available, after checking the request', async () => {
  const { deps, token } = await setup();
  const response = await handleApi(request('/launches/sources', token, JSON.stringify({ title: 't', sources: [{ kind: 'text', text: 'x' }] }), 'application/json'), deps);
  assert.equal(response.status, 409);
  assert.match(JSON.stringify(await response.json()), /not available/);
  assert.equal((await handleApi(request('/media', token, new Uint8Array([1]), 'application/octet-stream'), deps)).status, 409);
});

test('an upload is read up to the cap and no further, whatever its length says', async () => {
  const uploaded: number[] = [];
  const { deps, token } = await setup({
    start: unused,
    upload: async (bytes) => (uploaded.push(bytes.byteLength), { ok: true, file: { id: 1, sha256: 'a'.repeat(64), kind: 'image', mime: 'image/png', bytes: bytes.byteLength, width: 1, height: 1, storage: 'memory', path: 'media/aa/x' } }),
  });
  const ok = await handleApi(request('/media', token, new Uint8Array([1, 2, 3]), 'application/octet-stream'), deps);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { file: { sha256: 'a'.repeat(64), mime: 'image/png', bytes: 3, width: 1, height: 1 } });

  const declared = { headers: new Headers({ 'content-length': String(MAX_UPLOAD_BYTES + 1) }), body: null } as unknown as Request;
  assert.equal(await readCapped(declared, MAX_UPLOAD_BYTES), undefined, 'a declared length over the cap is not read at all');
  const big = await handleApi(request('/media', token, new Uint8Array(MAX_UPLOAD_BYTES + 1), 'application/octet-stream'), deps);
  assert.equal(big.status, 413);
  assert.deepEqual(uploaded, [3]);
});

test('the OpenAPI document describes both routes, the upload as bytes', async () => {
  const { deps } = await setup({ start: unused, upload: unused });
  const doc = openApiDocument('https://shipcast.example', deps) as { paths: Record<string, Record<string, { requestBody?: { content: Record<string, unknown> } }>> };
  assert.ok(doc.paths['/launches/sources']?.post?.requestBody?.content['application/json']);
  assert.ok(doc.paths['/media']?.post?.requestBody?.content['application/octet-stream']);
});

test('the request shape: a source of each kind, nothing else, and the title trimmed', () => {
  assert.deepEqual(sourcesRequest({ title: ' T ', sources: [{ kind: 'media', sha256: 'a'.repeat(64), alt: 'x', extra: 'ignored' }] }), { title: 'T', lang: 'en', channels: [], sources: [{ kind: 'media', sha256: 'a'.repeat(64), alt: 'x' }] });
  assert.throws(() => sourcesRequest({ title: 'T', sources: 'all of them' }), /must be a list/);
  assert.throws(() => sourcesRequest({ title: 'T', lang: 'fr', sources: [] }), /en or es/);
  assert.throws(() => sourcesRequest({ title: 'T', sources: [{ kind: 'url' }] }), /url must be text/);
});
