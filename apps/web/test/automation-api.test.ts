import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TriggerService, type ReviewGitHub } from '@shipcast/engine';
import { memoryRegistry } from '@shipcast/engine/testing';
import { createApiToken, MemoryStore, WEBHOOK_SECRET_KEY, type JobQueue } from '@shipcast/runtime';
import { FailureLimiter, handleApi, openApiDocument, type ApiDeps } from '../src/server/api.ts';
import { automationApi } from '../src/server/automation.server.ts';

/* The automation routes, on a PGlite registry with the queue faked: the same services the Automation page runs */

const unused = async (): Promise<never> => {
  throw new Error('the automation routes start no other work');
};

const SECRET = 'whsec-never-served';

async function setup() {
  const registry = await memoryRegistry();
  const secrets = new MemoryStore();
  await secrets.set(WEBHOOK_SECRET_KEY, SECRET, 'GitHub webhook secret');
  const sent: Array<{ reason: string; startAfter: unknown }> = [];
  // Only the round's upsert is reached; the rest of the queue stays out of these tests
  const queue = {
    upsert: async (_name: string, data: { reason: string }, opts: { startAfter?: unknown }) => {
      sent.push({ reason: data.reason, startAfter: opts.startAfter });
      return `round-${sent.length}`;
    },
  } as unknown as JobQueue;
  const triggers = new TriggerService({ registry, inTransaction: (work) => work(registry) });
  const deps: ApiDeps = {
    registry,
    secrets,
    github: {} as ReviewGitHub,
    launchesRepo: 'yeyo11/launches',
    launchRead: { review: async () => undefined, channelConfig: async () => undefined },
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
    automation: automationApi({ registry, queue, secrets, triggers, app: { publicUrl: 'https://shipcast.example' }, config: { githubApp: undefined } }),
  };
  const tokens = { registry, secrets };
  return { deps, registry, sent, read: (await createApiToken(tokens, 'reader', ['read'])).token, write: (await createApiToken(tokens, 'writer', ['write'])).token };
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
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) as Record<string, unknown> & { error?: { code: string; message: string } } };
}

test('the settings are read with the read scope, with whether a secret is set and never the secret', async () => {
  const s = await setup();
  const read = await call(s.deps, 'GET', '/automation', s.read);
  assert.equal(read.status, 200);
  const { triggers, ...settings } = read.body;
  assert.equal((triggers as unknown[]).length, 2, 'the default rules until rules are saved');
  assert.deepEqual(settings, {
    mode: 'poll',
    intervalSeconds: 300,
    running: false,
    lastRound: null,
    lastDelivery: null,
    webhookUrl: 'https://shipcast.example/api/github/webhook',
    hasSecret: true,
    appWebhooks: false,
  });
  assert.ok(!read.text.includes(SECRET));
  assert.equal((await call(s.deps, 'GET', '/automation', 'shipcast_1_wrong')).status, 401);
});

test('a change saves what is sent, keeps the rest, and sets the next round to it', async () => {
  const s = await setup();
  assert.equal((await call(s.deps, 'PATCH', '/automation', s.read, { mode: 'off' })).status, 403);
  for (const bad of [{}, { mode: 'sometimes' }, { intervalSeconds: 30 }, { intervalSeconds: 90.5 }, { intervalSeconds: '300' }, { mode: 'off', secret: 'x' }]) {
    assert.equal((await call(s.deps, 'PATCH', '/automation', s.write, bad)).status, 400, JSON.stringify(bad));
  }
  assert.deepEqual(s.sent, []);

  const interval = await call(s.deps, 'PATCH', '/automation', s.write, { intervalSeconds: 600 });
  assert.equal(interval.status, 200);
  assert.deepEqual(interval.body, { mode: 'poll', intervalSeconds: 600 });
  assert.deepEqual(s.sent, [{ reason: 'settings changed', startAfter: 15 }]);

  const off = await call(s.deps, 'PATCH', '/automation', s.write, { mode: 'off' });
  assert.deepEqual(off.body, { mode: 'off', intervalSeconds: 600 });
  assert.equal(s.sent.length, 1, 'no round while off');
  assert.equal((await call(s.deps, 'GET', '/automation', s.read)).body.mode, 'off');
});

test('the trigger rules are checked by the engine and replaced as a whole', async () => {
  const s = await setup();
  assert.equal(((await call(s.deps, 'GET', '/automation', s.read)).body.triggers as unknown[]).length, 2, 'the defaults until rules are saved');
  assert.equal((await call(s.deps, 'PUT', '/automation/triggers', s.read, { rules: [] })).status, 403);
  assert.equal((await call(s.deps, 'PUT', '/automation/triggers', s.write, [])).status, 400, 'the rules go in an object');
  assert.equal((await call(s.deps, 'PUT', '/automation/triggers', s.write, { rules: 'all' })).status, 400);
  const twice = await call(s.deps, 'PUT', '/automation/triggers', s.write, { rules: [{ id: 'a', event: 'release' }, { id: 'a', event: 'public' }] });
  assert.equal(twice.status, 400);
  assert.match(twice.body.error?.message ?? '', /two rules are called a/);

  const saved = await call(s.deps, 'PUT', '/automation/triggers', s.write, { rules: [{ id: 'mine', event: 'release', repos: 'yeyo11/*', channels: ['blog'] }] });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.rules, [{ id: 'mine', enabled: true, event: 'release', repos: 'yeyo11/*', prereleases: false, channels: ['blog'] }]);
  assert.deepEqual((await call(s.deps, 'GET', '/automation', s.read)).body.triggers, saved.body.rules);
});

test('a round now is a job, refused while one runs', async () => {
  const s = await setup();
  assert.equal((await call(s.deps, 'POST', '/automation/round', s.read)).status, 403);
  const started = await call(s.deps, 'POST', '/automation/round', s.write);
  assert.equal(started.status, 202);
  assert.deepEqual(started.body, { job: 'round-1' });
  assert.deepEqual(s.sent, [{ reason: 'by hand', startAfter: 0 }]);

  await s.registry.jobs.recordJob({ id: 'round-running', queue: 'round', title: 'Automation round' });
  await s.registry.jobs.updateJob('round-running', { state: 'active' });
  const busy = await call(s.deps, 'POST', '/automation/round', s.write);
  assert.equal(busy.status, 409);
  assert.match(busy.body.error?.message ?? '', /running already/);
  assert.equal((await call(s.deps, 'GET', '/automation', s.read)).body.running, true);
});

test('without the service in this process the routes refuse, and the OpenAPI document lists them', async () => {
  const s = await setup();
  const { automation: _, ...bare } = s.deps;
  assert.equal((await call(bare, 'GET', '/automation', s.read)).status, 409);
  assert.equal((await call(bare, 'POST', '/automation/round', s.write)).status, 409);
  const doc = openApiDocument('https://shipcast.example', {}) as { paths: Record<string, Record<string, { operationId: string }>>; components: { schemas: Record<string, unknown> } };
  assert.equal(doc.paths['/automation']?.get?.operationId, 'getAutomation');
  assert.equal(doc.paths['/automation']?.patch?.operationId, 'setAutomation');
  assert.equal(doc.paths['/automation/triggers']?.put?.operationId, 'setTriggers');
  assert.equal(doc.paths['/automation/round']?.post?.operationId, 'runRound');
  for (const name of ['AutomationState', 'AutomationMode', 'TriggerRule']) assert.ok(doc.components.schemas[name], name);
});
