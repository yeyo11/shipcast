import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReviewGitHub } from '@shipcast/engine';
import { memoryRegistry } from '@shipcast/engine/testing';
import { checkAccount, createApiToken, MemoryStore } from '@shipcast/runtime';
import type { AccountsApi } from '../src/server/accounts-api.ts';
import { FailureLimiter, handleApi, openApiDocument, type ApiDeps } from '../src/server/api.ts';

/* The account routes beyond the list, on a PGlite registry with the queue faked and no network reached */

const unused = async (): Promise<never> => {
  throw new Error('the account routes start no other work');
};

async function setup(options: { wired?: boolean; queueFull?: boolean } = {}) {
  const registry = await memoryRegistry();
  // An empty keychain: a check finds no secrets and records that, without asking any network
  const secrets = new MemoryStore();
  const synced: number[] = [];
  const accounts: AccountsApi = {
    check: async (id) => ((await registry.accounts.account(id)) ? checkAccount({ registry, secrets, brands: new Map() }, id) : undefined),
    sync: async (id) => {
      if (!(await registry.accounts.account(id))) return undefined;
      if (options.queueFull) return { ok: false, problem: 'the sync could not be queued' };
      synced.push(id);
      return { ok: true, job: `sync-${id}` };
    },
  };
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
    ...(options.wired !== false && { accounts }),
  };
  const tokens = { registry, secrets };
  const first = await registry.accounts.addAccount({ network: 'mastodon', brand: 'personal', label: '@me@m.example', settings: { instance: 'https://m.example' } });
  const second = await registry.accounts.addAccount({ network: 'mastodon', brand: 'personal', label: '@other@m.example', settings: { instance: 'https://m.example' } });
  return { deps, registry, synced, first, second, read: (await createApiToken(tokens, 'reader', ['read'])).token, write: (await createApiToken(tokens, 'writer', ['write'])).token };
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

type AccountBody = { account: { id: number; label: string; primary: boolean; status: string; problem: string | null; checkedAt: string | null } };

test('a check records its answer and gives the account back, with the write scope', async () => {
  const s = await setup();
  assert.equal((await call(s.deps, 'POST', `/accounts/${s.first.id}/check`, s.read)).status, 403);
  const checked = await call(s.deps, 'POST', `/accounts/${s.first.id}/check`, s.write);
  assert.equal(checked.status, 200);
  const { account } = checked.body as unknown as AccountBody;
  assert.equal(account.status, 'failed');
  assert.match(account.problem ?? '', /secrets are missing/);
  assert.ok(account.checkedAt);
  assert.equal((await s.registry.accounts.account(s.first.id))?.status, 'failed', 'the answer is recorded');
  assert.equal((await call(s.deps, 'POST', '/accounts/999/check', s.write)).status, 404);
  assert.equal((await call(s.deps, 'POST', '/accounts/x/check', s.write)).status, 400);
});

test('a sync is a job; an unknown account is a 404 and a sync that could not be queued a refusal', async () => {
  const s = await setup();
  assert.equal((await call(s.deps, 'POST', `/accounts/${s.first.id}/sync`, s.read)).status, 403);
  const started = await call(s.deps, 'POST', `/accounts/${s.first.id}/sync`, s.write);
  assert.equal(started.status, 202);
  assert.deepEqual(started.body, { job: `sync-${s.first.id}` });
  assert.deepEqual(s.synced, [s.first.id]);
  assert.equal((await call(s.deps, 'POST', '/accounts/999/sync', s.write)).status, 404);

  const full = await setup({ queueFull: true });
  const refused = await call(full.deps, 'POST', `/accounts/${full.first.id}/sync`, full.write);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error?.message, 'the sync could not be queued');
});

test('without the account services wired, a check and a sync are refused', async () => {
  const s = await setup({ wired: false });
  assert.equal((await call(s.deps, 'POST', `/accounts/${s.first.id}/check`, s.write)).status, 409);
  assert.equal((await call(s.deps, 'POST', `/accounts/${s.first.id}/sync`, s.write)).status, 409);
});

test('a rename changes only the label, trimmed, and refuses a blank one', async () => {
  const s = await setup();
  const path = `/accounts/${s.first.id}`;
  assert.equal((await call(s.deps, 'PATCH', path, s.read, { label: 'Personal' })).status, 403);
  for (const body of [{}, { label: '   ' }, { label: 7 }, { label: 'x'.repeat(201) }]) assert.equal((await call(s.deps, 'PATCH', path, s.write, body)).status, 400, JSON.stringify(body));
  const renamed = await call(s.deps, 'PATCH', path, s.write, { label: '  Personal ' });
  assert.equal(renamed.status, 200);
  assert.equal((renamed.body as unknown as AccountBody).account.label, 'Personal');
  assert.deepEqual((await s.registry.accounts.account(s.first.id))?.settings, { instance: 'https://m.example' });
  assert.equal((await call(s.deps, 'PATCH', '/accounts/999', s.write, { label: 'x' })).status, 404);
});

test('making an account primary moves its network’s primary to it', async () => {
  const s = await setup();
  assert.equal((await s.registry.accounts.account(s.first.id))?.primary, true, 'the first connected is primary');
  assert.equal((await call(s.deps, 'POST', `/accounts/${s.second.id}/primary`, s.read)).status, 403);
  const made = await call(s.deps, 'POST', `/accounts/${s.second.id}/primary`, s.write);
  assert.equal(made.status, 200);
  assert.equal((made.body as unknown as AccountBody).account.primary, true);
  assert.equal((await s.registry.accounts.account(s.first.id))?.primary, false);
  assert.equal((await call(s.deps, 'POST', '/accounts/999/primary', s.write)).status, 404);
});

test('the OpenAPI document lists the account routes', () => {
  const doc = openApiDocument('https://shipcast.example', {}) as { paths: Record<string, Record<string, { operationId?: string }>> };
  assert.equal(doc.paths['/accounts/{accountId}/check']?.post?.operationId, 'checkAccount');
  assert.equal(doc.paths['/accounts/{accountId}/sync']?.post?.operationId, 'syncAccount');
  assert.equal(doc.paths['/accounts/{accountId}']?.patch?.operationId, 'renameAccount');
  assert.equal(doc.paths['/accounts/{accountId}/primary']?.post?.operationId, 'makePrimaryAccount');
});
