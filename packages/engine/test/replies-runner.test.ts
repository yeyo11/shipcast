import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Comment } from '@shipcast/connectors';
import { ANALYSIS_RULES, Brand } from '@shipcast/schema';
import { draftReply, fetchComments, runComments, SdkProvider, type AiTaskRunner, type ReplyContext, type ReplyDeps, type Repositories } from '../src/index.ts';
import {
  claudioAnswer,
  claudioChats,
  claudioRefusal,
  codeloadUrl,
  fakeClaudio,
  fakeClaudioRunner,
  fakeGitHubArchives,
  jsonModel,
  memoryRegistry,
  mockRunner,
  scriptedModel,
  submitParts,
} from '../src/testing/index.ts';

/*
 * A comment's reply on the AI task runner (`ai-runner`): the same answer records the same draft as
 * the old provider path; a launch's code is read with the runner's tools over the clone or in a
 * Claudio workspace of the release; a failure leaves the comment failed with why, and the run goes on.
 */

const brand = Brand.parse({ id: 'personal', displayName: 'Me', site: 'https://josegarrido.dev', github: 'yeyo11' });
const answer = { classification: 'question', language: 'en', dismiss: false, reply: 'Not yet: Windows support is planned.', reason: 'They asked about Windows' };

const comment = (id: string, text: string): Comment => ({ externalId: id, author: { handle: '@ana@fosstodon.org', displayName: 'Ana' }, text, createdAt: '2026-10-21T10:00:00.000Z', own: false });

const analysis = { summary: 'Claude Code as a service', implemented: ['REST API'], planned: ['Windows support'], documentedOnly: [], limitations: [] };

async function world(): Promise<{ registry: Repositories; commentId: number }> {
  const registry = await memoryRegistry();
  const { launch } = await registry.launches.claim({ repo: 'yeyo11/claudio', ref: 'v1.0.0', trigger: 'release', kind: 'launch', brand: 'personal' });
  await registry.posts.recordPost({ launchId: launch.id, channel: 'mastodon', externalId: '100', url: 'https://mastodon.social/@me/100' });
  await fetchComments({ registry, connectors: async () => ({ reader: { comments: async () => [comment('101', 'Is there a Windows build?')] } }) });
  return { registry, commentId: (await registry.comments.commentByExternalId('mastodon', '101'))!.id };
}

function deps(registry: Repositories, ai: Pick<ReplyDeps, 'setup' | 'aiRunner' | 'texts'>, context: ReplyContext): ReplyDeps {
  return { registry, brand, connectors: async () => ({}), context: async () => context, ...ai };
}

const noCode: ReplyContext = { analysis, postText: { mastodon: 'claudio is out' }, cwd: '/workspace' };

async function recorded(registry: Repositories, id: number) {
  const c = (await registry.comments.comment(id))!;
  return { status: c.status, draft: c.draft, classification: c.classification, note: c.note, problem: c.problem };
}

test('replies: for the same answer the runner records the draft the old path records, from the same prompt', async () => {
  const before = await world();
  const oldModel = jsonModel(answer);
  await draftReply(before.commentId, deps(before.registry, { setup: async () => ({ provider: new SdkProvider({ id: 'test', model: () => oldModel }), prompts: {} }) }, noCode));
  const now = await world();
  const model = jsonModel(answer);
  await draftReply(now.commentId, deps(now.registry, { aiRunner: mockRunner(model) }, noCode));
  assert.deepEqual(await recorded(now.registry, now.commentId), await recorded(before.registry, before.commentId));
  assert.equal((await recorded(now.registry, now.commentId)).draft, answer.reply);
  const users = (calls: ReadonlyArray<{ prompt: ReadonlyArray<{ role: string }> }>) => JSON.stringify(calls[0]!.prompt.filter((m) => m.role === 'user'));
  assert.equal(users(model.doStreamCalls), users(oldModel.doGenerateCalls));
  assert.equal(model.doStreamCalls[0]!.tools, undefined, 'no code checked out: no tools');
});

test('replies: a launch’s clone is read with the runner’s tools, and the owner’s tone is in the prompt', async () => {
  const w = await world();
  const hostDir = await mkdtemp(join(tmpdir(), 'shipcast-reply-'));
  const model = scriptedModel(submitParts(answer));
  await draftReply(w.commentId, deps(w.registry, { aiRunner: mockRunner(model), texts: async () => ({ tone: 'Warm, never salesy.' }) }, { ...noCode, hostDir, repo: { name: 'yeyo11/claudio', ref: 'v1.0.0' } }));
  assert.equal((await recorded(w.registry, w.commentId)).draft, answer.reply);
  assert.ok((model.doStreamCalls[0]!.tools ?? []).some((t) => t.name === 'search'));
  assert.match(JSON.stringify(model.doStreamCalls[0]!.prompt), /Warm, never salesy\./);
});

test('replies: on Claudio the release is read in a workspace of its own, with the task’s turns and budget', async () => {
  const claudio = await fakeClaudio({ chat: (_, res) => claudioAnswer(res, JSON.stringify(answer)) });
  const gh = await fakeGitHubArchives();
  try {
    const w = await world();
    await draftReply(w.commentId, deps(w.registry, { aiRunner: fakeClaudioRunner(claudio, gh) }, { ...noCode, hostDir: '/unused', repo: { name: 'yeyo11/claudio', ref: 'v1.0.0' } }));
    assert.equal((await recorded(w.registry, w.commentId)).status, 'draft-ready');
    assert.deepEqual(JSON.parse(claudio.seen[0]!.body), { url: codeloadUrl('yeyo11/claudio', 'v1.0.0') });
    const chat = claudioChats(claudio)[0]!;
    assert.equal(chat.headers['x-claudio-workspace'], 'ws-1');
    assert.deepEqual(JSON.parse(String(chat.headers['x-claudio-allowed-tools'])), [...ANALYSIS_RULES]);
    assert.equal(chat.headers['x-claudio-max-turns'], '20');
    assert.equal(chat.headers['x-claudio-max-budget-usd'], '1', 'the task’s own: replies never took the settings’ budget');
  } finally {
    await Promise.all([claudio.close(), gh.close()]);
  }
});

test('replies: a refusal leaves the comment failed with why, and the run goes on', async () => {
  const claudio = await fakeClaudio({ chat: (_, res) => claudioRefusal(res, 401, 'invalid_api_key', 'bad token') });
  const gh = await fakeGitHubArchives();
  try {
    const w = await world();
    const runner: AiTaskRunner = fakeClaudioRunner(claudio, gh);
    const lines: string[] = [];
    const result = await runComments(
      { registry: w.registry, brand, aiRunner: runner, connectors: async () => ({ reader: { comments: async () => [comment('101', 'Is there a Windows build?')] } }), context: async () => noCode },
      { log: (line) => lines.push(line) },
    );
    assert.equal(result.drafted.length, 0);
    const stored = await recorded(w.registry, w.commentId);
    assert.equal(stored.status, 'failed');
    assert.match(stored.problem ?? '', /^could not draft: the .* refused its credentials \(401\)/);
    assert.ok(lines.some((l) => l.startsWith(`Comment ${w.commentId}: could not draft`)));
  } finally {
    await Promise.all([claudio.close(), gh.close()]);
  }
});
