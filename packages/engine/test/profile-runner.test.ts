import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AiError, Brand } from '@shipcast/schema';
import { readProfileReview, reviewProfile, type ProfileDeps, type Repositories } from '../src/index.ts';
import { claudioAnswer, claudioChats, claudioRefusal, fakeClaudio, fakeClaudioRunner, fakeGitHubArchives, memoryRegistry } from '../src/testing/index.ts';

/*
 * A profile review on the AI task runner, on Claudio: no repo, so no workspace, the
 * profile task's turns and budget on the call; a failure is an AiError that fails the review's job,
 * and nothing is stored.
 */

const brand = Brand.parse({ id: 'personal', displayName: 'Me', site: 'https://josegarrido.dev', github: 'yeyo11' });

async function world(): Promise<{ registry: Repositories; accountId: number }> {
  const registry = await memoryRegistry();
  const account = await registry.accounts.addAccount({ network: 'mastodon', brand: 'personal', label: '@me@mastodon.social', settings: { instance: 'https://mastodon.social', scopes: 'read:accounts write:accounts' } });
  return { registry, accountId: account.id };
}

const deps = (registry: Repositories, runner: ProfileDeps['aiRunner']): ProfileDeps => ({
  registry,
  brand,
  aiRunner: runner,
  connector: async () => ({ profile: async () => ({ displayName: 'Me', bio: 'Old bio', links: [], hasAvatar: true }) }),
  now: () => new Date('2026-10-27T10:00:00Z'),
});

test('profile: on Claudio the review is one call with the task’s turns and budget, and no workspace', async () => {
  const answer = { summary: 'Thin', proposals: [{ field: 'bio', current: 'x', proposed: 'Construyo Shipcast', why: 'Says what you build' }] };
  const claudio = await fakeClaudio({ chat: (_, res) => claudioAnswer(res, JSON.stringify(answer)) });
  const gh = await fakeGitHubArchives();
  try {
    const w = await world();
    const review = await reviewProfile(deps(w.registry, fakeClaudioRunner(claudio, gh)), w.accountId);
    assert.deepEqual(review.proposals.map((p) => [p.field, p.current, p.proposed]), [['bio', 'Old bio', 'Construyo Shipcast']]);
    assert.deepEqual(claudio.seen.map((s) => `${s.method} ${s.path}`), ['POST /api/v1/chat/completions']);
    const chat = claudioChats(claudio)[0]!;
    assert.equal(chat.headers['x-claudio-max-turns'], '5');
    assert.equal(chat.headers['x-claudio-max-budget-usd'], '0.5');
  } finally {
    await Promise.all([claudio.close(), gh.close()]);
  }
});

test('profile: a provider’s failure fails the review as an AiError, and nothing is stored', async () => {
  const claudio = await fakeClaudio({ chat: (_, res) => claudioRefusal(res, 429, 'rate_limit_exceeded', 'session limit') });
  const gh = await fakeGitHubArchives();
  try {
    const w = await world();
    const error = await reviewProfile(deps(w.registry, fakeClaudioRunner(claudio, gh)), w.accountId).catch((e: unknown) => e);
    assert.ok(error instanceof AiError);
    assert.equal(error.code, 'ai_rate_limited');
    assert.match(error.message, /usage limit/);
    assert.equal(await readProfileReview(w.registry, w.accountId), undefined);
  } finally {
    await Promise.all([claudio.close(), gh.close()]);
  }
});
