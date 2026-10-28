import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { GitHubRest, PipelineDeps, Repositories } from '@shipcast/engine';
import { clonePglite, connectPglite, memoryRegistry, registryOn } from '@shipcast/engine/testing';
import { Brand } from '@shipcast/schema';
import {
  accountSecretKey,
  BY_HAND,
  isStale,
  lastSynced,
  MemoryStore,
  syncNow,
  WorkQueue,
  workHandlers,
  writeAutomation,
  type JobContext,
  type QueueOptions,
  type WorkDeps,
} from '../src/index.ts';

const brand = Brand.parse({ id: 'personal', displayName: 'Me', site: 'https://josegarrido.dev', github: 'yeyo11' });

/** Each network's API as the sync reaches it: a check, then the profile's counts */
const networks = (async (input: string | URL | Request) => {
  const url = String(input);
  if (url === 'https://dev.to/api/users/me') return Response.json({ username: 'me', profile_image: 'https://media.dev.to/me.png' });
  if (url.startsWith('https://dev.to/api/followers/users')) return Response.json([{ id: 1 }, { id: 2 }]);
  if (url.startsWith('https://dev.to/api/articles/me/published')) return Response.json([{ id: 1 }]);
  if (url === 'https://mastodon.social/api/v1/accounts/verify_credentials') {
    return Response.json({ acct: 'me', avatar: 'https://files.mastodon.social/me.png', followers_count: 30, following_count: 12, statuses_count: 200 });
  }
  if (url.startsWith('https://discord.com/api/webhooks/1/t')) return Response.json({ id: '1', name: 'Launches' });
  return new Response('unexpected', { status: 500 });
}) as typeof fetch;

/** Three connected accounts, each with its secrets in the keychain; a Discord webhook counts nothing */
async function connected(registry: Repositories, secrets: MemoryStore): Promise<Record<string, number>> {
  const ids: Record<string, number> = {};
  const add = async (network: string, label: string, settings: Record<string, string>, secret: Record<string, string>) => {
    const account = await registry.accounts.addAccount({ network, brand: 'personal', label, settings });
    await secrets.set(accountSecretKey(account.id), JSON.stringify(secret), label);
    ids[network] = account.id;
  };
  await add('devto', '@me', {}, { apiKey: 'k' });
  await add('mastodon', '@me@mastodon.social', { instance: 'https://mastodon.social' }, { accessToken: 't' });
  await add('discord', 'Launches', {}, { webhookUrl: 'https://discord.com/api/webhooks/1/t' });
  return ids;
}

const workDeps = (registry: Repositories, secrets: MemoryStore): WorkDeps => ({
  env: {},
  registry,
  github: {} as unknown as GitHubRest,
  secrets,
  pipeline: {} as unknown as PipelineDeps,
  brand: async () => brand,
  fetch: networks,
});

function job(lines: string[]): JobContext {
  return { id: 'j', attempt: 1, lastAttempt: true, log: (line) => void lines.push(line), link: () => {}, signal: new AbortController().signal };
}

test('the daily job checks every account, records a snapshot where the network counts, and skips the rest', async () => {
  const registry = await memoryRegistry();
  const secrets = new MemoryStore();
  const ids = await connected(registry, secrets);
  const lines: string[] = [];
  const { snapshots } = workHandlers({} as unknown as WorkQueue, workDeps(registry, secrets));
  await snapshots!({ reason: 'daily' }, job(lines));

  const last = await registry.accounts.lastSnapshots();
  assert.deepEqual([last.get(ids.devto!)?.followers, last.get(ids.devto!)?.posts, last.get(ids.devto!)?.following], [2, 1, null]);
  assert.deepEqual([last.get(ids.mastodon!)?.followers, last.get(ids.mastodon!)?.following, last.get(ids.mastodon!)?.posts], [30, 12, 200]);
  assert.equal(last.has(ids.discord!), false, 'a webhook gives no counts');

  // Every account was checked again, and the picture the check found is kept
  assert.equal((await registry.accounts.account(ids.mastodon!))?.avatarUrl, 'https://files.mastodon.social/me.png');
  assert.equal((await registry.accounts.account(ids.devto!))?.avatarUrl, 'https://media.dev.to/me.png');
  assert.equal((await registry.accounts.account(ids.discord!))?.status, 'ok');
  assert.ok(lines.some((l) => /Discord Launches: checked; its network gives no follower counts/.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => /Mastodon @me@mastodon\.social: 30 followers, 12 following, 200 posts/.test(l)), lines.join('\n'));
});

test('an account whose check fails records no numbers, and the others still sync', async () => {
  const registry = await memoryRegistry();
  const secrets = new MemoryStore();
  const ids = await connected(registry, secrets);
  await secrets.delete(accountSecretKey(ids.mastodon!));
  const lines: string[] = [];
  await workHandlers({} as unknown as WorkQueue, workDeps(registry, secrets)).snapshots!({ reason: 'daily' }, job(lines));
  const last = await registry.accounts.lastSnapshots();
  assert.equal(last.has(ids.mastodon!), false);
  assert.equal(last.get(ids.devto!)?.followers, 2);
  assert.equal((await registry.accounts.account(ids.mastodon!))?.status, 'failed');
});

test('with automation off the daily job waits, and the same job by hand runs', async () => {
  const registry = await memoryRegistry();
  const secrets = new MemoryStore();
  const ids = await connected(registry, secrets);
  await writeAutomation(registry, { mode: 'off', intervalSeconds: 300 });
  const { snapshots } = workHandlers({} as unknown as WorkQueue, workDeps(registry, secrets));
  await snapshots!({ reason: 'daily' }, job([]));
  assert.equal((await registry.accounts.lastSnapshots()).size, 0);
  await snapshots!({ reason: BY_HAND, accountId: ids.devto! }, job([]));
  assert.deepEqual([...(await registry.accounts.lastSnapshots()).keys()], [ids.devto]);
});

test('an account is stale after 36 hours without a snapshot or a check', () => {
  const now = new Date('2026-10-25T12:00:00Z');
  assert.equal(lastSynced({ checkedAt: '2026-10-24T01:00:00.000Z' }, '2026-10-25T04:00:00.000Z'), '2026-10-25T04:00:00.000Z');
  assert.equal(lastSynced({ checkedAt: '2026-10-25T09:00:00.000Z' }, undefined), '2026-10-25T09:00:00.000Z');
  assert.equal(isStale('2026-10-24T01:00:00.000Z', now), false);
  assert.equal(isStale('2026-10-23T23:00:00.000Z', now), true);
  assert.equal(isStale(null, now), true);
});

/* Sync now goes through the real queue: pg-boss on PGlite, as queue.test.ts runs it */

const quiet: QueueOptions = { schedule: false, supervise: false, pollingIntervalSeconds: 0.5, retryDelaySeconds: 1, onError: () => {} };

const template = (async () => {
  const { client, close } = await connectPglite();
  const queue = WorkQueue.pglite(client, await registryOn(client), quiet);
  await queue.start();
  await queue.stop();
  return { client, close };
})();

const queues: WorkQueue[] = [];
after(async () => {
  await Promise.all(queues.splice(0).map((q) => q.stop(1000)));
  await (await template).close();
});

test('Sync now queues one job for that account, a second click is the same job, and it syncs only that account', async () => {
  const client = await clonePglite((await template).client);
  const registry = await registryOn(client);
  const secrets = new MemoryStore();
  const ids = await connected(registry, secrets);
  const queue = WorkQueue.pglite(client, registry, quiet);
  queues.push(queue);

  const account = (await registry.accounts.account(ids.mastodon!))!;
  const first = await syncNow(queue, account);
  assert.ok(first);
  assert.equal(await syncNow(queue, account), first, 'a second click while it waits is the same job');
  assert.equal((await registry.jobs.job(first))?.title, `Syncing ${account.label}`);
  assert.deepEqual(await queue.queued('snapshots', `account:${ids.devto}`), [], 'another account has nothing queued');

  await queue.work({ snapshots: workHandlers(queue, workDeps(registry, secrets)).snapshots! });
  const done = await queue.wait(first, 20_000, 100);
  assert.equal(done?.state, 'completed', done?.log.join('\n'));
  assert.deepEqual([...(await registry.accounts.lastSnapshots()).keys()], [ids.mastodon]);
  assert.equal(done?.link, '/channels');
});
