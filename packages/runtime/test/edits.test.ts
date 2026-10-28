import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PostRefused } from '@shipcast/engine';
import { memoryRegistry } from '@shipcast/engine/testing';
import { Brand } from '@shipcast/schema';
import { accountSecretKey, commentConnectors, MemoryStore, postEditors } from '../src/index.ts';

const brand = Brand.parse({ id: 'personal', displayName: 'Me', site: 'https://josegarrido.dev', github: 'yeyo11' });
const company = Brand.parse({ id: 'company', displayName: 'Co', site: 'https://co.example', github: 'co' });

/** Records which token each request carried */
function recording(seen: string[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push(`${init?.method ?? 'GET'} ${String(input)} ${(init?.headers as Record<string, string> | undefined)?.authorization ?? ''}`);
    return Response.json({});
  }) as typeof fetch;
}

test('a piece is edited with the account it went out with, not the primary of today', async () => {
  const registry = await memoryRegistry();
  const secrets = new MemoryStore();
  const old = await registry.accounts.addAccount({ network: 'mastodon', brand: 'personal', label: '@old', settings: { instance: 'https://old.example' } });
  const now = await registry.accounts.addAccount({ network: 'mastodon', brand: 'personal', label: '@new', settings: { instance: 'https://new.example' } });
  await registry.accounts.makePrimary(now.id);
  await secrets.set(accountSecretKey(old.id), JSON.stringify({ accessToken: 'old-token' }), 'mastodon @old');
  await secrets.set(accountSecretKey(now.id), JSON.stringify({ accessToken: 'new-token' }), 'mastodon @new');
  const seen: string[] = [];
  const editors = postEditors({ env: { MASTODON_INSTANCE: 'https://env.example', MASTODON_ACCESS_TOKEN: 'env-token' }, brand, registry, secrets, fetch: recording(seen) });

  await (await editors('mastodon', old.id)).mastodon!.delete('1');
  await (await editors('mastodon', null)).mastodon!.delete('2');
  assert.deepEqual(seen, ['DELETE https://old.example/api/v1/statuses/1 Bearer old-token', 'DELETE https://env.example/api/v1/statuses/2 Bearer env-token']);
});

test('an account removed or without secrets is refused; .env never speaks for another brand', async () => {
  const registry = await memoryRegistry();
  const secrets = new MemoryStore();
  const account = await registry.accounts.addAccount({ network: 'telegram', brand: 'personal', label: '@bot', settings: { chatId: '@c' } });
  const env = { TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: '@c' };
  await assert.rejects(postEditors({ env, brand, registry, secrets })('telegram', account.id), (e) => e instanceof PostRefused && e.reason === 'no_credentials');
  assert.deepEqual(await postEditors({ env, brand: company, registry, secrets })('telegram', null), {});
  assert.deepEqual(await postEditors({ env, brand, registry, secrets })('reddit', null), {}, 'a channel with no connector has no editor');
  assert.ok((await postEditors({ env, brand, registry, secrets })('telegram', null)).telegram);
});

test('GitHub Discussions is edited and read with the engine’s GitHub access, with no account', async () => {
  const registry = await memoryRegistry();
  const secrets = new MemoryStore();
  const seen: string[] = [];
  const github = { auth: { token: async () => 'installation-token' } };
  const editors = await postEditors({ env: {}, brand, registry, secrets, github, fetch: recording(seen) })('githubDiscussions', null);
  await assert.rejects(editors.githubDiscussions!.delete('D_1'));
  assert.deepEqual(seen, ['POST https://api.github.com/graphql Bearer installation-token']);
  assert.deepEqual(await postEditors({ env: {}, brand, registry, secrets })('githubDiscussions', null), {}, 'without GitHub access there is no editor');
  const connectors = await commentConnectors({ env: {}, brand, registry, secrets, github })('githubDiscussions', null);
  assert.ok(connectors.reader && connectors.replier);
});
