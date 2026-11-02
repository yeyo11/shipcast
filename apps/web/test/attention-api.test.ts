import assert from 'node:assert/strict';
import { test } from 'node:test';
import { failureKey } from '@shipcast/schema/failures';
import type { ReviewGitHub } from '@shipcast/engine';
import { aPublishedLaunch, memoryRegistry } from '@shipcast/engine/testing';
import { createApiToken, MemoryStore } from '@shipcast/runtime';
import { FailureLimiter, handleApi, openApiDocument, type ApiDeps } from '../src/server/api.ts';
import { attentionApi } from '../src/server/attention.server.ts';
import type { AppContext } from '../src/server/context.server.ts';

/* The attention routes, on a PGlite registry, through the same service as the bell's server functions */

const unused = async (): Promise<never> => {
  throw new Error('the attention routes start no work');
};

async function setup(options: { wired?: boolean } = {}) {
  const registry = await memoryRegistry();
  const secrets = new MemoryStore();
  // The bell's service reads only the registry and whether launch-store is on
  const ctx = { registry, launchStore: undefined } as unknown as AppContext;
  const deps: ApiDeps = {
    registry,
    secrets,
    github: {} as ReviewGitHub,
    launchesRepo: 'yeyo11/launches',
    launchRead: { review: async () => undefined, channelConfig: async () => undefined },
    publicUrl: 'https://shipcast.example/',
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
    ...(options.wired !== false && { attention: attentionApi(ctx) }),
  };
  const tokens = { registry, secrets };
  return { deps, registry, ctx, read: (await createApiToken(tokens, 'reader', ['read'])).token, write: (await createApiToken(tokens, 'writer', ['write'])).token };
}

async function call(deps: ApiDeps, method: string, path: string, token: string, body?: unknown, contentType = 'application/json') {
  const response = await handleApi(
    new Request(`https://shipcast.example/api/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined && { 'content-type': contentType }) },
      ...(body !== undefined && { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    }),
    deps,
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> & { error?: { code: string; message: string } } };
}

interface Line {
  key: string;
  kind: string;
  url: string;
  launchId?: number;
  accountId?: number;
  target?: unknown;
}

/** A launch that failed on dev.to and an account whose credential stopped working */
async function troubles(s: Awaited<ReturnType<typeof setup>>) {
  const { launch } = await aPublishedLaunch(s.registry, []);
  await s.registry.cursors.setCursor(failureKey(launch.id, 'devto'), 'dev.to refused the article');
  const account = await s.registry.accounts.addAccount({ network: 'mastodon', brand: 'personal', label: '@me@m.example', settings: { instance: 'https://m.example' } });
  await s.registry.accounts.recordCheck(account.id, { ok: false, problem: 'the token was revoked' });
  return { launch, account };
}

test('GET /attention is the bell’s list, with the ids it names and the app’s links instead of the router’s targets', async () => {
  const s = await setup();
  const { launch, account } = await troubles(s);
  const listed = await call(s.deps, 'GET', '/attention', s.read);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.count, 2);
  const items = listed.body.items as Line[];
  const retry = items.find((i) => i.kind === 'retry');
  const reconnect = items.find((i) => i.kind === 'reconnect');
  assert.equal(retry?.launchId, launch.id);
  assert.equal(retry?.url, `https://shipcast.example/launches/${launch.id}`);
  assert.equal(reconnect?.accountId, account.id);
  assert.equal(reconnect?.url, `https://shipcast.example/channels?focus=${account.id}`);
  assert.ok(items.every((i) => i.target === undefined), 'the router’s target stays in the app');

  // The same list as the page's server function gets, keys and all
  const page = await attentionApi(s.ctx).list();
  assert.deepEqual(items.map((i) => i.key), page.items.map((i) => i.key));
});

test('POST /attention/dismiss hides lines until their condition changes, as the bell’s dismissal does', async () => {
  const s = await setup();
  const { account } = await troubles(s);
  const before = (await call(s.deps, 'GET', '/attention', s.read)).body.items as Line[];
  const reconnect = before.find((i) => i.kind === 'reconnect')!;

  const dismissed = await call(s.deps, 'POST', '/attention/dismiss', s.write, { keys: [reconnect.key] });
  assert.deepEqual(dismissed, { status: 200, body: { dismissed: 1 } });
  const after = await call(s.deps, 'GET', '/attention', s.read);
  assert.equal(after.body.count, 1);
  assert.deepEqual((after.body.items as Line[]).map((i) => i.kind), ['retry']);
  assert.deepEqual((await attentionApi(s.ctx).list()).items.map((i) => i.kind), ['retry'], 'the app’s bell hides it too');

  // Another problem is another condition: the line is back
  await s.registry.accounts.recordCheck(account.id, { ok: false, problem: 'the instance is gone' });
  const back = await call(s.deps, 'GET', '/attention', s.read);
  assert.equal(back.body.count, 2);
});

test('a dismissal takes 1 to 100 keys shaped like the bell’s lines, as JSON, with the write scope', async () => {
  const s = await setup();
  const refused = async (body: unknown, contentType?: string) => {
    const answer = await call(s.deps, 'POST', '/attention/dismiss', s.write, body, contentType);
    assert.equal(answer.status, 400, JSON.stringify(body));
    return answer.body.error?.message ?? '';
  };
  assert.match(await refused({ keys: [] }), /1 to 100 keys/);
  assert.match(await refused({ keys: Array.from({ length: 101 }, (_, i) => `launch:${i}:waiting:x`) }), /1 to 100 keys/);
  assert.match(await refused({ keys: ['not a key'] }), /not a line of the bell/);
  assert.match(await refused({ keys: [42] }), /must be text/);
  assert.match(await refused({}), /keys must be a list/);
  assert.match(await refused('{', 'application/json'), /not valid JSON/);
  assert.match(await refused('keys=a', 'application/x-www-form-urlencoded'), /send JSON/);

  const readOnly = await call(s.deps, 'POST', '/attention/dismiss', s.read, { keys: ['launch:1:waiting:x'] });
  assert.equal(readOnly.status, 403);
});

test('without the service wired the routes refuse, and both are in the OpenAPI document', async () => {
  const s = await setup({ wired: false });
  assert.equal((await call(s.deps, 'GET', '/attention', s.read)).status, 409);
  assert.equal((await call(s.deps, 'POST', '/attention/dismiss', s.write, { keys: ['launch:1:waiting:x'] })).status, 409);

  const doc = openApiDocument('https://shipcast.example', s.deps) as { paths: Record<string, Record<string, { operationId: string }>>; components: { schemas: Record<string, unknown> } };
  assert.equal(doc.paths['/attention']?.get?.operationId, 'listAttention');
  assert.equal(doc.paths['/attention/dismiss']?.post?.operationId, 'dismissAttention');
  assert.ok(doc.components.schemas.AttentionItem);
});
