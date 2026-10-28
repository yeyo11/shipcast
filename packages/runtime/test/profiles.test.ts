import assert from 'node:assert/strict';
import { test } from 'node:test';
import { editProfile, readProfileReview, type AiProvider, type PipelineDeps } from '@shipcast/engine';
import { jsonModel, memoryRegistry, mockRunner } from '@shipcast/engine/testing';
import { Brand } from '@shipcast/schema';
import { accountSecretKey, MemoryStore, profileConnector, profileDeps, runProfileReview } from '../src/index.ts';

/*
 * The account analysis wired as the app runs it, with every network faked by a fetch that records
 * what it was asked: an account's own credential reaches its own instance and nothing else.
 */

const brand = Brand.parse({ id: 'personal', displayName: 'Me', site: 'https://josegarrido.dev', github: 'yeyo11' });

/** The AI faked: one structured answer, whatever it is asked */
const fakeAi = (output: unknown): AiProvider => ({
  id: 'test',
  generateObject: async () => ({ output, costUsd: null }),
  streamText: async function* () {},
});

function fakeMastodon(seen: string[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    seen.push(`${method} ${String(input)} ${(init?.headers as Record<string, string> | undefined)?.authorization ?? ''}`);
    if (String(input).endsWith('/api/v1/accounts/verify_credentials')) {
      return Response.json({ id: '1', acct: 'me', display_name: 'Me', avatar: 'https://x.example/a.png', source: { note: 'Old bio', fields: [] } });
    }
    if (method === 'PATCH') return Response.json({ id: '1' });
    return new Response('unexpected', { status: 500 });
  }) as typeof fetch;
}

test('a review reads the profile with the account’s own token, and applying a proposal edits that account', async () => {
  const registry = await memoryRegistry();
  const secrets = new MemoryStore();
  const account = await registry.accounts.addAccount({
    network: 'mastodon',
    brand: 'personal',
    label: '@me@mastodon.example',
    settings: { instance: 'https://mastodon.example', scopes: 'read:accounts read:statuses write:statuses write:media write:accounts' },
  });
  await secrets.set(accountSecretKey(account.id), JSON.stringify({ accessToken: 'its-token' }), 'mastodon @me');
  const seen: string[] = [];
  const pipeline = { ai: fakeAi({ summary: 'Thin', proposals: [{ field: 'bio', current: '', proposed: 'Construyo Shipcast', why: 'Says what you build' }] }) } as unknown as PipelineDeps;
  const d = { registry, secrets, pipeline, brand, fetch: fakeMastodon(seen) };
  const lines: string[] = [];

  await runProfileReview(d, { accountId: account.id }, (line) => lines.push(line));
  assert.deepEqual(lines, ['Thin', 'bio: Construyo Shipcast']);
  assert.deepEqual(seen, ['GET https://mastodon.example/api/v1/accounts/verify_credentials Bearer its-token']);
  const review = (await readProfileReview(registry, account.id))!;
  assert.equal(review.proposals[0]?.current, 'Old bio');

  await editProfile(profileDeps(d), account.id, { bio: review.proposals[0]!.proposed });
  assert.equal(seen[1], 'PATCH https://mastodon.example/api/v1/accounts/update_credentials Bearer its-token');
});

test('an account whose secrets are gone has no connector', async () => {
  const registry = await memoryRegistry();
  const account = await registry.accounts.addAccount({ network: 'bluesky', brand: 'personal', label: '@me', settings: { handle: 'me.bsky.social' } });
  assert.equal(await profileConnector({ secrets: new MemoryStore(), brand })(account), undefined);
});

test('with ai-runner the review job runs on the pipeline’s runner, with the owner’s texts, and records what the old path records', async () => {
  const answer = { summary: 'Thin', proposals: [{ field: 'bio', current: '', proposed: 'Construyo Shipcast', why: 'Says what you build' }] };
  const run = async (pipeline: PipelineDeps) => {
    const registry = await memoryRegistry();
    const secrets = new MemoryStore();
    const account = await registry.accounts.addAccount({ network: 'mastodon', brand: 'personal', label: '@me@mastodon.example', settings: { instance: 'https://mastodon.example', scopes: 'read:accounts write:accounts' } });
    await secrets.set(accountSecretKey(account.id), JSON.stringify({ accessToken: 'its-token' }), 'mastodon @me');
    const lines: string[] = [];
    await runProfileReview({ registry, secrets, pipeline, brand, fetch: fakeMastodon([]) }, { accountId: account.id }, (line) => lines.push(line));
    const { reviewedAt: _at, ...review } = (await readProfileReview(registry, account.id))!;
    return { lines, review: { ...review, accountId: 0 } };
  };
  const old = await run({ ai: fakeAi(answer) } as unknown as PipelineDeps);
  const model = jsonModel(answer);
  const unused: AiProvider = { id: 'test', generateObject: async () => assert.fail('the old provider is not asked'), streamText: async function* () {} };
  const now = await run({ ai: unused, aiRunner: mockRunner(model), aiTexts: async () => ({ tone: 'Plain words.' }) } as unknown as PipelineDeps);
  assert.deepEqual(now, old);
  assert.match(JSON.stringify(model.doStreamCalls[0]!.prompt), /Plain words\./);
  assert.ok(!('setup' in profileDeps({ registry: await memoryRegistry(), secrets: new MemoryStore(), brand, pipeline: { aiRunner: mockRunner(model) } as unknown as PipelineDeps })), 'no old provider set up beside the runner');
});
