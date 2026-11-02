import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConnectorError, type ProfileEdit } from '@shipcast/connectors';
import { editProfile, proposalEdit, readProfileReview, setBrandPicture, type ProfileDeps, type ReviewGitHub } from '@shipcast/engine';
import { memoryRegistry } from '@shipcast/engine/testing';
import { createApiToken, MemoryStore } from '@shipcast/runtime';
import { Brand } from '@shipcast/schema';
import { FailureLimiter, handleApi, openApiDocument, type ApiDeps } from '../src/server/api.ts';
import type { ReviewInput } from '../src/server/profile-api.ts';

/* The account analysis routes, on a PGlite registry with the work and the networks faked */

const unused = async (): Promise<never> => {
  throw new Error('the profile routes start no other work');
};

const AVATAR = 'https://cdn.example/me.png';
const brand = Brand.parse({ id: 'personal', displayName: 'Me', site: 'https://josegarrido.dev', github: 'yeyo11', languages: { blog: ['es', 'en'] }, tone: 'plain' });

async function setup(options: { networkFails?: boolean; noAvatar?: boolean } = {}) {
  const registry = await memoryRegistry();
  const secrets = new MemoryStore();
  const reviews: Array<[number, ReviewInput]> = [];
  const edits: ProfileEdit[] = [];
  // The engine's own checks, with the network faked
  const network: Pick<ProfileDeps, 'registry' | 'connector' | 'brand'> = {
    registry,
    connector: async () => ({
      editProfile: async (e) => {
        if (options.networkFails) throw new ConnectorError('Bluesky', 'the profile changed while it was being edited', 409, false);
        edits.push(e);
      },
    }),
    brand: options.noAvatar ? brand : { ...brand, avatar: AVATAR },
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
    profiles: {
      review: async (id, input) => {
        if (!(await registry.accounts.account(id))) return { ok: false, problem: 'no such account' };
        reviews.push([id, input]);
        return { ok: true, job: 'job-1' };
      },
      edit: (id, edit) => editProfile(network, id, edit),
      // As profiles.server.ts's applyProposal, over the faked network
      applyProposal: (id, proposal) => editProfile(network, id, proposalEdit({ field: proposal.field, proposed: proposal.value })),
      brandPicture: (id) => setBrandPicture(network, id),
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

test('a review’s proposal is applied through the engine’s checks, as sent, and marked applied', async () => {
  const s = await setup();
  const bsky = await s.registry.accounts.addAccount({ network: 'bluesky', brand: 'personal', label: '@me.bsky.social', settings: {} });
  const proposal = { field: 'bio', current: 'Hi', proposed: 'I build launch tools', why: 'Say what you make' };
  const review = { accountId: bsky.id, network: 'bluesky', reviewedAt: '2026-10-30T10:00:00.000Z', language: 'en', summary: 'Say it', profile: { displayName: 'Me', bio: 'Hi', links: [], hasAvatar: false }, proposals: [proposal] };
  await s.registry.cursors.setCursor(`profile-review:${bsky.id}`, JSON.stringify(review));
  const path = `/accounts/${bsky.id}/profile-review/apply`;

  assert.equal((await call(s.deps, 'POST', path, s.read, { field: 'bio', value: proposal.proposed })).status, 403);
  for (const body of [{}, { field: 'avatar', value: 'x' }, { field: 'bio' }, { field: 'bio', value: 'x'.repeat(5001) }]) {
    assert.equal((await call(s.deps, 'POST', path, s.write, body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await call(s.deps, 'POST', path, s.write, { field: 'bio', value: 'x'.repeat(300) })).status, 400, 'over the network’s limit');
  assert.equal((await call(s.deps, 'POST', path, s.write, { field: 'links', value: 'not a link line' })).status, 400);
  assert.equal((await call(s.deps, 'POST', '/accounts/999/profile-review/apply', s.write, { field: 'bio', value: 'x' })).status, 404);
  assert.deepEqual(s.edits, [], 'nothing reached the network');

  const done = await call(s.deps, 'POST', path, s.write, { field: 'bio', value: proposal.proposed });
  assert.equal(done.status, 200);
  assert.equal(done.body.profile, null);
  assert.deepEqual(s.edits, [{ bio: proposal.proposed }]);
  assert.ok((await readProfileReview(s.registry, bsky.id))?.proposals[0]?.appliedAt, 'the proposal is marked applied');
});

test('the brand picture is brand.yml’s avatar, where the network takes one', async () => {
  const s = await setup();
  const discord = await s.registry.accounts.addAccount({ network: 'discord', brand: 'personal', label: '#releases', settings: {} });
  const mastodon = await s.registry.accounts.addAccount({ network: 'mastodon', brand: 'personal', label: '@me@m.example', settings: { instance: 'https://m.example', scopes: 'read write' } });
  assert.equal((await call(s.deps, 'POST', `/accounts/${discord.id}/profile/picture`, s.read)).status, 403);
  assert.equal((await call(s.deps, 'POST', `/accounts/${mastodon.id}/profile/picture`, s.write)).status, 409);
  assert.equal((await call(s.deps, 'POST', '/accounts/999/profile/picture', s.write)).status, 404);
  const done = await call(s.deps, 'POST', `/accounts/${discord.id}/profile/picture`, s.write);
  assert.equal(done.status, 200);
  assert.deepEqual(s.edits, [{ picture: AVATAR }]);

  const without = await setup({ noAvatar: true });
  const other = await without.registry.accounts.addAccount({ network: 'discord', brand: 'personal', label: '#releases', settings: {} });
  const refused = await call(without.deps, 'POST', `/accounts/${other.id}/profile/picture`, without.write);
  assert.equal(refused.status, 400);
  assert.match(refused.body.error?.message ?? '', /avatar/);
});

test('the OpenAPI document lists the profile routes and their schemas', () => {
  const doc = openApiDocument('https://shipcast.example', {}) as { paths: Record<string, Record<string, unknown>>; components: { schemas: Record<string, unknown> } };
  assert.ok(doc.paths['/profile-capabilities']?.get);
  assert.ok(doc.paths['/accounts/{accountId}/profile-review']?.get);
  assert.ok(doc.paths['/accounts/{accountId}/profile-review']?.post);
  assert.ok(doc.paths['/accounts/{accountId}/profile']?.patch);
  assert.ok(doc.paths['/accounts/{accountId}/profile-review/apply']?.post);
  assert.ok(doc.paths['/accounts/{accountId}/profile/picture']?.post);
  for (const name of ['ProfileCapability', 'ProfileReview', 'Profile']) assert.ok(doc.components.schemas[name], name);
});
