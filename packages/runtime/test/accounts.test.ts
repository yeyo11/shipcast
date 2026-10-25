import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryRegistry } from '@shipcast/engine/testing';
import { Brand } from '@shipcast/schema';
import {
  accountSecretKey,
  checkAccount,
  connectAccount,
  disconnectAccount,
  importFromEnv,
  MemoryStore,
  MissingField,
  NETWORKS,
  splitFields,
  type AccountDeps,
} from '../src/index.ts';

const brand = Brand.parse({ id: 'personal', displayName: 'Me', site: 'https://josegarrido.dev', github: 'yeyo11' });

/** dev.to answers its check with the key's owner, or refuses a key named "bad" */
const devtoFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
  const key = (init?.headers as Record<string, string>)['api-key'];
  return key === 'bad' ? new Response('{"error":"unauthorized"}', { status: 401 }) : Response.json({ username: 'yeyo11' });
}) as typeof fetch;

async function deps(): Promise<AccountDeps> {
  return { registry: await memoryRegistry(), secrets: new MemoryStore(), brands: new Map([['personal', brand]]), fetch: devtoFetch };
}

test('every network in the catalog says what it does and how to get its credential', () => {
  for (const n of NETWORKS) {
    assert.ok(n.permissions.length > 0, n.id);
    assert.ok(n.howTo.length > 0, n.id);
  }
});

test('a form is split into public settings and secrets, and a required field cannot be empty', () => {
  assert.deepEqual(splitFields('bluesky', { handle: ' me.bsky.social ', appPassword: 'p' }), { settings: { handle: 'me.bsky.social' }, secrets: { appPassword: 'p' } });
  assert.throws(() => splitFields('bluesky', { handle: 'x' }), MissingField);
});

test('an account is kept only when its credential works; its secret goes to the keychain', async () => {
  const d = await deps();
  const refused = await connectAccount(d, { network: 'devto', brand: 'personal', credentials: { settings: {}, secrets: { apiKey: 'bad' } } });
  assert.equal(refused.ok, false);
  assert.match((refused as { problem: string }).problem, /rejected the credential/);
  assert.equal((await d.registry.accounts()).length, 0);

  const connected = await connectAccount(d, { network: 'devto', brand: 'personal', credentials: { settings: {}, secrets: { apiKey: 'good' } } });
  assert.ok(connected.ok);
  const account = (connected as { account: { id: number; label: string; status: string; primary: boolean } }).account;
  assert.deepEqual([account.label, account.status, account.primary], ['@yeyo11', 'ok', true]);
  assert.equal(await d.secrets.get(accountSecretKey(account.id)), JSON.stringify({ apiKey: 'good' }));
  assert.equal(JSON.stringify((await d.registry.account(account.id))?.settings), '{}', 'no secret in the registry');

  const again = await connectAccount(d, { network: 'devto', brand: 'personal', credentials: { settings: {}, secrets: { apiKey: 'newer' } } });
  assert.ok(again.ok);
  assert.equal((await d.registry.accounts()).length, 1, 'connecting the same account again updates it');

  assert.equal((await checkAccount(d, account.id)).status, 'ok');
  await disconnectAccount(d, account.id);
  assert.equal((await d.registry.accounts()).length, 0);
  assert.equal(await d.secrets.get(accountSecretKey(account.id)), undefined);
});

test('an account whose secrets left the keychain fails its check with what to do', async () => {
  const d = await deps();
  const account = await d.registry.addAccount({ network: 'devto', brand: 'personal', label: 'x', settings: {} });
  const checked = await checkAccount(d, account.id);
  assert.equal(checked.status, 'failed');
  assert.match(checked.problem ?? '', /connect it again/);
});

test('importing from .env connects what it holds for the brand it speaks for', async () => {
  const d = await deps();
  const results = await importFromEnv(d, { DEVTO_API_KEY: 'good', GITHUB_TOKEN_PERSONAL: 'g' }, () => '');
  assert.deepEqual(results.map((r) => [r.network, r.result.ok]), [['devto', true]]);
  assert.deepEqual(await importFromEnv(d, { DEVTO_API_KEY: 'good' }, () => ''), [], 'already connected');
});
