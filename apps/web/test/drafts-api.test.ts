import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppReviewRefused, LaunchNotHeld, type AppReviewService, type Launch, type LaunchReadService, type Review, type ReviewGitHub, type SitePreview } from '@shipcast/engine';
import { memoryRegistry } from '@shipcast/engine/testing';
import { createApiToken, MemoryStore } from '@shipcast/runtime';
import { FailureLimiter, handleApi, openApiDocument, type ApiDeps } from '../src/server/api.ts';
import type { AppContext } from '../src/server/context.server.ts';
import { draftsApi } from '../src/server/drafts.server.ts';

/*
 * The drafts routes on a PGlite registry, through the same service the launch page's server functions
 * call (draftsApi), with the launch model's reads, the app review and the publishing faked. A launch
 * Shipcast holds is read and edited; one decided in its pull request before the launch model and not
 * imported is refused.
 */

const ARTICLE = 'src/content/posts/en/claudio.md';
const LAUNCHES_REPO = 'yeyo11/launches';

const unused = async (): Promise<never> => {
  throw new Error('the drafts routes start no other work');
};

async function setup() {
  const registry = await memoryRegistry();
  const secrets = new MemoryStore();
  const edits: string[] = [];
  const published: string[] = [];
  const github = {} as ReviewGitHub;
  const preview: SitePreview = { branch: 'preview/launch-2-abc', number: 40, pullRequest: `https://github.com/${LAUNCHES_REPO}/pull/40`, sha: 'c1', at: '2026-11-01T10:00:00.000Z' };
  let previewAsked = false;
  // The app review's answers as the launch model would give them; its own checks are the engine's tests
  const appReview = {
    edit: async (launch: Launch, path: string, content: string, author: string | null) => {
      if (path !== ARTICLE) throw new AppReviewRefused('state', `${path} is out already: edit it on its channel`);
      edits.push(`${launch.id} ${path} ${JSON.stringify(content)} ${author}`);
    },
    requestPreview: async () => {
      previewAsked = true;
      return preview;
    },
    findPreview: async () => (previewAsked ? { ...preview, url: 'https://preview-abc.workers.dev', urlSha: 'c1' } : undefined),
  } as unknown as AppReviewService;
  // What the context's launch service needs; nothing else of the app is reached
  const ctx = { registry, deps: { github, registry, launchesRepo: LAUNCHES_REPO }, github, appReview } as unknown as AppContext;
  const held: Review = { app: { open: true, approval: null, waiting: {}, preview: null, published: null, versions: { 1: 1 } }, drafts: [{ path: ARTICLE, label: 'Article (en)', kind: 'article', content: '# Held\n', approved: false }] };
  const launchRead: Pick<LaunchReadService, 'review' | 'channelConfig'> = {
    review: async (launch) => {
      if (launch.model !== 'app') throw new LaunchNotHeld(launch);
      return held;
    },
    channelConfig: async () => undefined,
  };
  const deps: ApiDeps = {
    registry,
    secrets,
    github,
    launchesRepo: LAUNCHES_REPO,
    launchRead,
    publicUrl: 'https://shipcast.example',
    limiter: new FailureLimiter(),
    jobs: async () => ({ jobs: [], next: null }),
    startLaunch: unused,
    approve: unused,
    startArticle: unused,
    startPublishing: async (launch: Launch, channel) => {
      published.push(`${launch.id} ${channel ?? 'all'}`);
      return 'j9';
    },
    editing: unused,
    armSchedule: unused,
    comments: unused,
    checkComments: unused,
    redraftComment: unused,
    drafts: draftsApi(ctx),
  };
  const claim = async (ref: string) => (await registry.launches.claim({ repo: 'yeyo11/claudio', ref, trigger: 'release', kind: 'launch', brand: 'personal' })).launch;
  // A launch decided in its pull request before the launch model, and one Shipcast holds
  const legacy = await registry.launches.setStatus((await claim('v1.0.0')).id, 'drafted', `Drafts: https://github.com/${LAUNCHES_REPO}/pull/7`);
  const app = await registry.launches.setModel((await registry.launches.setStatus((await claim('v2.0.0')).id, 'drafted')).id, 'app');
  const tokens = { registry, secrets };
  return {
    deps,
    registry,
    edits,
    published,
    legacy,
    app,
    read: (await createApiToken(tokens, 'reader', ['read'])).token,
    write: (await createApiToken(tokens, 'writer', ['write'])).token,
  };
}

async function call(deps: ApiDeps, method: string, path: string, token: string, body?: unknown) {
  const response = await handleApi(
    new Request(`https://shipcast.example/api/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined && { 'content-type': 'application/json' }) },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    }),
    deps,
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> & { error?: { code: string; message: string } } };
}

const draftUrl = (id: number, path = ARTICLE) => `/launches/${id}/draft?path=${encodeURIComponent(path)}`;

test('a draft is read in full from the launch model', async () => {
  const s = await setup();
  const read = await call(s.deps, 'GET', draftUrl(s.app.id), s.read);
  assert.equal(read.status, 200);
  assert.deepEqual(read.body, { draft: { path: ARTICLE, label: 'Article (en)', kind: 'article', content: '# Held\n', approved: false }, open: true });

  const notHeld = await call(s.deps, 'GET', draftUrl(s.legacy.id), s.read);
  assert.equal(notHeld.status, 409);
  assert.match(notHeld.body.error?.message ?? '', /not held by Shipcast/);
  assert.equal((await call(s.deps, 'GET', draftUrl(s.app.id, 'nope.md'), s.read)).status, 404);
  assert.equal((await call(s.deps, 'GET', draftUrl(999), s.read)).status, 404);
  assert.equal((await call(s.deps, 'GET', `/launches/${s.app.id}/draft`, s.read)).status, 400, 'the path is required');
});

test('an edit is a new version through the app review, which says what it refuses', async () => {
  const s = await setup();
  assert.equal((await call(s.deps, 'PUT', `/launches/${s.app.id}/draft`, s.read, { path: ARTICLE, content: 'x' })).status, 403, 'editing needs the write scope');
  const edited = await call(s.deps, 'PUT', `/launches/${s.app.id}/draft`, s.write, { path: ARTICLE, content: '# Claudio, edited' });
  assert.equal(edited.status, 200);
  assert.deepEqual(edited.body, { path: ARTICLE });
  assert.deepEqual(s.edits, [`${s.app.id} ${ARTICLE} "# Claudio, edited" api`]);

  const out = await call(s.deps, 'PUT', `/launches/${s.app.id}/draft`, s.write, { path: 'launches/claudio/v2.0.0/bluesky.md', content: 'x' });
  assert.equal(out.status, 409);
  assert.match(out.body.error?.message ?? '', /out already/);
  const decided = await call(s.deps, 'PUT', `/launches/${s.legacy.id}/draft`, s.write, { path: ARTICLE, content: 'x' });
  assert.equal(decided.status, 409);
  assert.match(decided.body.error?.message ?? '', /decided in a pull request/);
  assert.equal((await call(s.deps, 'PUT', `/launches/999/draft`, s.write, { path: ARTICLE, content: 'x' })).status, 404);
  assert.equal((await call(s.deps, 'PUT', `/launches/${s.app.id}/draft`, s.write, { path: ARTICLE })).status, 400, 'the content is required');
  assert.equal(s.edits.length, 1);
});

test('the site preview is asked for and found for a launch Shipcast holds only', async () => {
  const s = await setup();
  assert.equal((await call(s.deps, 'GET', `/launches/${s.app.id}/site-preview`, s.read)).status, 404, 'no preview was asked for yet');
  const ofPr = await call(s.deps, 'POST', `/launches/${s.legacy.id}/site-preview`, s.write);
  assert.equal(ofPr.status, 409);
  assert.match(ofPr.body.error?.message ?? '', /had its own preview/);

  const asked = await call(s.deps, 'POST', `/launches/${s.app.id}/site-preview`, s.write);
  assert.equal(asked.status, 200);
  assert.equal((asked.body.preview as SitePreview).url, undefined, 'the address comes once the site deployed it');
  const found = await call(s.deps, 'GET', `/launches/${s.app.id}/site-preview`, s.read);
  assert.equal(found.status, 200);
  assert.equal((found.body.preview as SitePreview).url, 'https://preview-abc.workers.dev');
  assert.equal((await call(s.deps, 'POST', '/launches/999/site-preview', s.write)).status, 404);
});

test('publishing a whole launch again queues it when drafted, through the same use case as retrying a channel', async () => {
  const s = await setup();
  const again = await call(s.deps, 'POST', `/launches/${s.app.id}/publish`, s.write);
  assert.equal(again.status, 202);
  assert.deepEqual(again.body, { job: 'j9' });
  const retry = await call(s.deps, 'POST', `/launches/${s.app.id}/retry/devto`, s.write);
  assert.equal(retry.status, 202);
  assert.deepEqual(s.published, [`${s.app.id} all`, `${s.app.id} devto`]);

  await s.registry.launches.setStatus(s.app.id, 'published');
  const refused = await call(s.deps, 'POST', `/launches/${s.app.id}/publish`, s.write);
  assert.equal(refused.status, 409);
  assert.match(refused.body.error?.message ?? '', /the launch is published/);
  assert.equal((await call(s.deps, 'POST', '/launches/999/publish', s.write)).status, 404);
  assert.equal(s.published.length, 2, 'a refused launch is not queued');
});

test('without the drafts services the routes refuse, and the OpenAPI document lists them', async () => {
  const s = await setup();
  const bare: ApiDeps = { ...s.deps };
  delete bare.drafts;
  const refused = await call(bare, 'PUT', `/launches/${s.app.id}/draft`, s.write, { path: ARTICLE, content: 'x' });
  assert.equal(refused.status, 409);
  const doc = openApiDocument('https://shipcast.example', {}) as { paths: Record<string, Record<string, { operationId: string }>> };
  assert.equal(doc.paths['/launches/{id}/draft']?.get?.operationId, 'getDraft');
  assert.equal(doc.paths['/launches/{id}/draft']?.put?.operationId, 'editDraft');
  assert.equal(doc.paths['/launches/{id}/site-preview']?.post?.operationId, 'requestSitePreview');
  assert.equal(doc.paths['/launches/{id}/site-preview']?.get?.operationId, 'getSitePreview');
  assert.equal(doc.paths['/launches/{id}/publish']?.post?.operationId, 'publishLaunchAgain');
});
