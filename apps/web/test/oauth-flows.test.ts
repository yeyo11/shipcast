import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Account } from '@shipcast/engine';
import type { ConnectedAccount, NetworkSpec, OAuthSpec, SettingsValues } from '@shipcast/runtime';
import { MemoryOneTimeStore } from '@shipcast/runtime/redis';
import { connectAll, flowSpec, oauthFlows, startFlow, type Connect } from '../src/server/oauth-flows.ts';

/*
 * A sign-in's round trip without a network: the flow keeps the variant it started with through the
 * one-time store, the callback finishes with that variant whatever Settings says by then, and every
 * account the consent shared is kept, the refused ones said beside the one that connected.
 */

const specOf = (id: string, name: string): OAuthSpec & { label: string } => ({
  label: name,
  app: { id, term: 'app', name },
  authorizeUrl: () => `https://example.test/${id}`,
  exchange: async () => [],
  errorParams: ['error'],
});
const instagramLogin = specOf('instagram', 'Instagram');
const unified = specOf('meta', 'Meta');

const instagram: NetworkSpec = {
  id: 'instagram',
  auth: 'oauth',
  fields: [],
  permissions: [],
  howTo: '',
  oauth: { setting: 'instagramLogin', fallback: 'instagram', variants: { instagram: instagramLogin, unified } },
  build: () => {
    throw new Error('never built in this test');
  },
};

const settings = (instagramLogin?: string) => ({ instagramLogin }) as SettingsValues;
const params = (values: Record<string, string> = {}) => new URLSearchParams(values);
const callback = (state: string) => new URL(`https://app.example/auth/instagram/callback?${new URLSearchParams({ state, code: 'c' })}`);

test('a flow keeps the variant it started with through the one-time store, and is good once', async () => {
  const flows = oauthFlows(new MemoryOneTimeStore());
  const started = startFlow(instagram, settings('unified'), params({ brand: 'personal', label: 'Mine' }));
  assert.ok(started);
  assert.equal(started.spec, unified);
  assert.deepEqual(started.flow, { network: 'instagram', brand: 'personal', label: 'Mine', variant: 'unified' });
  const state = await flows.remember(started.flow);
  assert.deepEqual(await flows.take(callback(state), 'instagram'), { network: 'instagram', brand: 'personal', label: 'Mine', variant: 'unified' });
  assert.equal(await flows.take(callback(state), 'instagram'), undefined, 'a state is never good twice');
});

test('an unset setting starts the fallback, and the flow names it', () => {
  const started = startFlow(instagram, settings(), params());
  assert.equal(started?.spec, instagramLogin);
  assert.equal(started?.flow.variant, 'instagram');
  assert.equal(started?.flow.brand, 'personal');
});

test('the callback finishes the variant its flow started, after the setting changed', async () => {
  const flows = oauthFlows(new MemoryOneTimeStore());
  const started = startFlow(instagram, settings('unified'), params());
  assert.ok(started);
  const flow = await flows.take(callback(await flows.remember(started.flow)), 'instagram');
  assert.ok(flow);
  // The owner switched Settings back to Instagram Login while Meta's consent was open
  assert.equal(flowSpec(instagram, settings('instagram'), flow), unified);
  assert.equal(flowSpec(instagram, settings('instagram'), { ...flow, variant: undefined }), instagramLogin, 'a flow from before variants follows Settings');
});

function accountOf(id: number, label: string): Account {
  return { id, network: 'instagram', brand: 'personal', label, settings: {}, primary: false, status: 'ok', identity: `@${label}`, problem: null, checkedAt: null, createdAt: '2026-11-05T00:00:00.000Z', avatarUrl: null };
}
const shared = (userId: string, label?: string): ConnectedAccount => ({ ...(label && { label }), credentials: { settings: { userId }, secrets: { accessToken: `token-${userId}` } } });

/** A connect that refuses the user ids it is told to, and records what it was asked */
function fakeConnect(refuse: string[] = []): { connect: Connect; calls: Array<{ label: string | undefined; userId: string | undefined }> } {
  const calls: Array<{ label: string | undefined; userId: string | undefined }> = [];
  let next = 41;
  const connect: Connect = async (input) => {
    const userId = input.credentials.settings.userId;
    calls.push({ label: input.label, userId });
    if (userId && refuse.includes(userId)) return { ok: false, problem: `${userId} is not a professional account` };
    next += 1;
    return { ok: true, account: accountOf(next, input.label ?? `ig-${userId}`) };
  };
  return { connect, calls };
}

const location = (response: Response) => {
  assert.equal(response.status, 302);
  return new URL(response.headers.get('location') ?? '', 'https://app.example');
};

test('a consent that shared no account goes back to the network with that said', async () => {
  const { connect, calls } = fakeConnect();
  const to = location(await connectAll(connect, 'instagram', { brand: 'personal' }, []));
  assert.equal(to.pathname, '/channels/instagram');
  assert.equal(to.searchParams.get('problem'), 'Instagram shared no account with Shipcast.');
  assert.equal(calls.length, 0);
});

test("one account takes the label the owner typed, over the network's", async () => {
  const { connect, calls } = fakeConnect();
  const to = location(await connectAll(connect, 'instagram', { brand: 'personal', label: 'Mine' }, [shared('17841416971174401', 'network-label')]));
  assert.deepEqual(calls, [{ label: 'Mine', userId: '17841416971174401' }]);
  assert.equal(to.pathname, '/channels');
  assert.equal(to.searchParams.get('focus'), '42');
  assert.equal(to.searchParams.get('connected'), 'Connected @Mine');
  assert.equal(to.searchParams.get('problem'), null);
});

test('several accounts each keep their own label; one refused is said beside the one that connected', async () => {
  const { connect, calls } = fakeConnect(['17841400000000001']);
  const accounts = [shared('17841400000000001', 'first'), shared('17841416971174401', 'second'), shared('17841400000000003')];
  const to = location(await connectAll(connect, 'instagram', { brand: 'personal', label: 'Mine' }, accounts));
  assert.deepEqual(
    calls.map((c) => c.label),
    ['first', 'second', undefined],
    'the typed label names one account, never several',
  );
  assert.equal(to.pathname, '/channels');
  assert.equal(to.searchParams.get('focus'), '42', 'it lands on the first account that connected');
  assert.equal(to.searchParams.get('problem'), '17841400000000001 is not a professional account');
});

test('when no account connects, every problem goes back to the network', async () => {
  const { connect } = fakeConnect(['1', '2']);
  const to = location(await connectAll(connect, 'instagram', { brand: 'personal' }, [shared('1'), shared('2')]));
  assert.equal(to.pathname, '/channels/instagram');
  assert.equal(to.searchParams.get('problem'), '1 is not a professional account; 2 is not a professional account');
});
