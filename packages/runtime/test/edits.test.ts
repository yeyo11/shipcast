import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PostGone } from '@shipcast/connectors';
import { PostRefused } from '@shipcast/engine';
import { memoryRegistry } from '@shipcast/engine/testing';
import { Brand } from '@shipcast/schema';
import { accountSecretKey, commentConnectors, MemoryStore, postEditors } from '../src/index.ts';

const brand = Brand.parse({ id: 'personal', displayName: 'Me', site: 'https://josegarrido.dev', github: 'yeyo11', languages: { blog: ['en', 'es'] } });
const company = Brand.parse({ id: 'company', displayName: 'Co', site: 'https://co.example', github: 'co', languages: { blog: ['en', 'es'] } });

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

/*
 * A post whose account was disconnected (account_id null) and whose network has nothing in .env: the
 * brand's one account of that network may stand in, only where the network can prove the post is
 * that account's (YouTube: the video's channel is the account's channel). A connector that stands in
 * never takes a 404 for a post gone: it might only be another account's post.
 */

/** Google for one channel, `UC-me`: v-other is another channel's video, v-hidden one it cannot see, v-404's comments answer 404 */
function youtube(log: string[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    log.push(`${init?.method ?? 'GET'} ${url.replace('https://www.googleapis.com/youtube/v3', '')}`);
    if (url.startsWith('https://oauth2.googleapis.com/token')) return Response.json({ access_token: 'access' });
    if (url.includes('/channels?part=id&mine=true')) return Response.json({ items: [{ id: 'UC-me' }] });
    const video = /\/videos\?part=snippet&id=([^&]+)/.exec(url)?.[1];
    if (video) return Response.json({ items: video === 'v-hidden' ? [] : [{ id: video, snippet: { channelId: video === 'v-other' ? 'UC-other' : 'UC-me' } }] });
    if (url.includes('/commentThreads') && url.includes('videoId=v-mine')) return Response.json({ items: [] });
    if (url.includes('/commentThreads')) return Response.json({ error: { code: 404 } }, { status: 404 });
    if (init?.method === 'DELETE') return new Response(null, { status: 204 });
    return Response.json({});
  }) as typeof fetch;
}

async function oneYouTubeAccount() {
  const registry = await memoryRegistry();
  const store = new MemoryStore();
  const account = await registry.accounts.addAccount({ network: 'youtube', brand: 'personal', label: '@josegarridodev', settings: { clientId: 'client-1' } });
  await store.set(accountSecretKey(account.id), JSON.stringify({ clientSecret: 's', refreshToken: 'r' }), 'youtube @josegarridodev');
  return { registry, secrets: store };
}

type Deleter = Record<string, { delete(id: string): Promise<void> }>;

test('a YouTube post whose account was disconnected is read and edited with the brand’s one account, when the video is its channel’s', async () => {
  const { registry, secrets } = await oneYouTubeAccount();
  const log: string[] = [];
  const deps = { env: {}, brand, registry, secrets, fetch: youtube(log) };
  const { reader } = await commentConnectors(deps)('youtube', null);
  assert.deepEqual(await reader!.comments('v-mine'), []);
  const editor = (await postEditors(deps)('youtube', null)) as Deleter;
  await editor.youtube!.delete('v-mine');
  assert.ok(log.some((l) => l.startsWith('DELETE /videos?id=v-mine')));
});

test('a stand-in account never acts on a video it cannot prove is its own, and never takes a 404 for a post gone', async () => {
  const { registry, secrets } = await oneYouTubeAccount();
  const log: string[] = [];
  const deps = { env: {}, brand, registry, secrets, fetch: youtube(log) };
  const { reader } = await commentConnectors(deps)('youtube', null);
  const refused = (e: unknown) => e instanceof PostRefused && !(e instanceof PostGone) && /assign/.test((e as Error).message);
  await assert.rejects(reader!.comments('v-other'), refused, 'another channel’s video');
  await assert.rejects(reader!.comments('v-hidden'), refused, 'a video the account cannot see: not gone, not its own');
  const editor = (await postEditors(deps)('youtube', null)) as Deleter;
  await assert.rejects(editor.youtube!.delete('v-hidden'), refused, 'never deleted as "already gone"');
  assert.ok(!log.some((l) => l.startsWith('DELETE')), 'nothing deleted');
});

test('a comment read that answers 404 through a stand-in is a refusal, never a post gone', async () => {
  const { registry, secrets } = await oneYouTubeAccount();
  const { reader } = await commentConnectors({ env: {}, brand, registry, secrets, fetch: youtube() })('youtube', null);
  await assert.rejects(reader!.comments('v-404'), (e) => e instanceof PostRefused && !(e instanceof PostGone));
});

test('no stand-in where the network cannot prove whose a post is, nor with several accounts', async () => {
  const registry = await memoryRegistry();
  const store = new MemoryStore();
  const mastodon = await registry.accounts.addAccount({ network: 'mastodon', brand: 'personal', label: '@me', settings: { instance: 'https://m.example' } });
  await store.set(accountSecretKey(mastodon.id), JSON.stringify({ accessToken: 't' }), 'mastodon @me');
  assert.deepEqual(await commentConnectors({ env: {}, brand, registry, secrets: store })('mastodon', null), {}, 'Mastodon: no stand-in');
  assert.deepEqual(await postEditors({ env: {}, brand, registry, secrets: store })('mastodon', null), {});

  const two = await oneYouTubeAccount();
  const other = await two.registry.accounts.addAccount({ network: 'youtube', brand: 'personal', label: '@other', settings: { clientId: 'client-2' } });
  await two.secrets.set(accountSecretKey(other.id), JSON.stringify({ clientSecret: 's', refreshToken: 'r' }), 'youtube @other');
  await assert.rejects(
    commentConnectors({ env: {}, brand, registry: two.registry, secrets: two.secrets })('youtube', null),
    (e) => e instanceof PostRefused && e.reason === 'no_credentials' && /disconnected/.test(e.message) && /assign/.test(e.message),
  );
});
