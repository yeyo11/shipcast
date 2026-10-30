import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConnectorError, type ProfileEdit } from '@shipcast/connectors';
import { editProfile, type ReviewGitHub } from '@shipcast/engine';
import { memoryRegistry } from '@shipcast/engine/testing';
import { createApiToken, MemoryStore } from '@shipcast/runtime';
import { FailureLimiter, handleApi, openApiDocument, type ApiDeps } from '../src/server/api.ts';
import type { ReviewInput } from '../src/server/profile-api.ts';

/* The account analysis routes, on a PGlite registry with the work and the networks faked */

const unused = async (): Promise<never> => {
  throw new Error('the profile routes start no other work');
};

async function setup(options: { networkFails?: boolean } = {}) {
  const registry = await memoryRegistry();
  const secrets = new MemoryStore();
  const reviews: Array<[number, ReviewInput]> = [];
  const edits: ProfileEdit[] = [];
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
    profiles: {
      review: async (id, input) => {
        if (!(await registry.accounts.account(id))) return { ok: false, problem: 'no such account' };
        reviews.push([id, input]);
        return { ok: true, job: 'job-1' };
      },
      // The engine's own checks, with the network faked
      edit: (id, edit) =>
        editProfile(
          {
            registry,
            connector: async () => ({
              editProfile: async (e) => {
                if (options.networkFails) throw new ConnectorError('Bluesky', 'the profile changed while it was being edited', 409, false);
                edits.push(e);
              },
            }),
          },
          id,
          edit,
        ),
    },
  };
  const tokens = { registry, secrets };
  return { deps, registry, reviews, edits, read: (await createApiToken(tokens, 'reader', ['read'])).token, write: (await createApiToken(tokens, 'writer', ['write'])).token };
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

test('the capabilities and an account’s review are read with the read scope', async () => {
  const s = await setup();
  const old = await s.registry.accounts.addAccount({ network: 'mastodon', brand: 'personal', label: '@me@m.example', settings: { instance: 'https://m.example' } });
  const caps = await call(s.deps, 'GET', '/profile-capabilities', s.read);
  assert.equal(caps.status, 200);
  assert.equal((caps.body.capabilities as Record<string, { edit: string }>).bluesky?.edit, 'yes');

  const view = await call(s.deps, 'GET', `/accounts/${old.id}/profile-review`, s.read);
  assert.equal(view.status, 200);
  assert.equal((view.body.capability as { edit: string }).edit, 'reconnect', 'a token from before write:accounts');
  assert.equal(view.body.review, null);
  assert.equal((await call(s.deps, 'GET', '/accounts/999/profile-review', s.read)).status, 404);
  assert.equal((await call(s.deps, 'GET', '/accounts/x/profile-review', s.read)).status, 400);
});

test('a review is a job, started with the write scope, with what the owner pasted', async () => {
  const s = await setup();
  const ig = await s.registry.accounts.addAccount({ network: 'instagram', brand: 'personal', label: '@me', settings: {} });
  assert.equal((await call(s.deps, 'POST', `/accounts/${ig.id}/profile-review`, s.read, {})).status, 403);
  const started = await call(s.deps, 'POST', `/accounts/${ig.id}/profile-review`, s.write, { pasted: { bio: 'I make things' }, language: 'es' });
  assert.equal(started.status, 202);
  assert.equal(started.body.job, 'job-1');
  assert.deepEqual(s.reviews, [[ig.id, { pasted: { bio: 'I make things' }, language: 'es' }]]);
  assert.equal((await call(s.deps, 'POST', `/accounts/${ig.id}/profile-review`, s.write, { language: 'spanish' })).status, 400);
  assert.equal((await call(s.deps, 'POST', '/accounts/999/profile-review', s.write, {})).status, 404);
});

test('an edit goes through the engine’s checks before the network, and the network’s refusal is a 502', async () => {
  const s = await setup();
  const bsky = await s.registry.accounts.addAccount({ network: 'bluesky', brand: 'personal', label: '@me.bsky.social', settings: {} });
  const ig = await s.registry.accounts.addAccount({ network: 'instagram', brand: 'personal', label: '@me', settings: {} });
  assert.equal((await call(s.deps, 'PATCH', `/accounts/${bsky.id}/profile`, s.read, { bio: 'x' })).status, 403);
  assert.equal((await call(s.deps, 'PATCH', `/accounts/${bsky.id}/profile`, s.write, {})).status, 400);
  assert.equal((await call(s.deps, 'PATCH', `/accounts/${bsky.id}/profile`, s.write, { avatar: 'x' })).status, 400);
  assert.equal((await call(s.deps, 'PATCH', `/accounts/${bsky.id}/profile`, s.write, { bio: 'x'.repeat(300) })).status, 400);
  const telegram = await s.registry.accounts.addAccount({ network: 'telegram', brand: 'personal', label: '@shipnews', settings: {} });
  assert.equal((await call(s.deps, 'PATCH', `/accounts/${telegram.id}/profile`, s.write, { links: [] })).status, 400, 'a field the network cannot change');
  assert.equal((await call(s.deps, 'PATCH', `/accounts/${ig.id}/profile`, s.write, { bio: 'x' })).status, 409);
  const done = await call(s.deps, 'PATCH', `/accounts/${bsky.id}/profile`, s.write, { bio: 'Builder' });
  assert.equal(done.status, 200);
  assert.equal(done.body.profile, null);
  assert.deepEqual(s.edits, [{ bio: 'Builder' }]);

  const failing = await setup({ networkFails: true });
  const other = await failing.registry.accounts.addAccount({ network: 'bluesky', brand: 'personal', label: '@me.bsky.social', settings: {} });
  const refused = await call(failing.deps, 'PATCH', `/accounts/${other.id}/profile`, failing.write, { bio: 'x' });
  assert.equal(refused.status, 502);
  assert.equal(refused.body.error?.code, 'upstream');
});

test('the OpenAPI document lists the profile routes and their schemas', () => {
  const doc = openApiDocument('https://shipcast.example', {}) as { paths: Record<string, Record<string, unknown>>; components: { schemas: Record<string, unknown> } };
  assert.ok(doc.paths['/profile-capabilities']?.get);
  assert.ok(doc.paths['/accounts/{accountId}/profile-review']?.get);
  assert.ok(doc.paths['/accounts/{accountId}/profile-review']?.post);
  assert.ok(doc.paths['/accounts/{accountId}/profile']?.patch);
  for (const name of ['ProfileCapability', 'ProfileReview', 'Profile']) assert.ok(doc.components.schemas[name], name);
});
