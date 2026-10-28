import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claimArticle, draftArticle, loadBrand, SdkProvider, type PipelineDeps } from '../src/index.ts';
import { claudioAnswer, claudioChats, claudioRefusal, fakeClaudio, fakeClaudioRunner, fakeGitHubArchives, FakeGitHub, jsonModel, memoryRegistry, mockRunner, scriptedModel, textParts } from '../src/testing/index.ts';

/*
 * An article on the AI task runner (`ai-runner`): the same answer leaves the same drafts and launch as
 * the old provider path; no repo is read, so Claudio gets no workspace; a failure fails the launch with
 * a readable problem.
 */

const BRAND_YML = 'id: personal\ndisplayName: Me\nsite: https://josegarrido.dev\ngithub: yeyo11\n';
const version = { title: 'T', description: 'd', markdown: 'AI copy' };
const pack = {
  schemaVersion: 1,
  kind: 'launch',
  project: { name: 'x', repo: 'https://github.com/x/y' },
  analysis: { summary: 's', implemented: ['x'], planned: [], documentedOnly: [], limitations: [] },
  article: { en: { slug: 'claudio', ...version }, es: { slug: 'claudio-es', ...version } },
  bluesky: { lang: 'en', text: 'b' },
};
const input = { title: 'My own title', markdown: 'My own words.', lang: 'en' as const, channels: ['bluesky' as const] };

const unused = new SdkProvider({ id: 'test', model: () => assert.fail('the old provider is not asked with the runner') });

async function draft(ai: Pick<PipelineDeps, 'ai' | 'aiRunner'> & Partial<Pick<PipelineDeps, 'maxBudgetUsd'>>) {
  const github = new FakeGitHub({ files: { 'yeyo11/launches/brand.yml@HEAD': BRAND_YML } });
  const registry = await memoryRegistry();
  const deps: PipelineDeps = {
    github,
    registry,
    launchesRepo: 'yeyo11/launches',
    checkout: async () => assert.fail('an article clones nothing'),
    now: () => new Date('2026-10-25T00:00:00Z'),
    fetch: (async () => new Response(null, { status: 404 })) as typeof fetch,
    ...ai,
  };
  const brand = await loadBrand(github, 'yeyo11/launches');
  const { launch } = await claimArticle(input, brand, deps);
  const result = await draftArticle(launch, input, brand, deps);
  const after = (await registry.launches.get(launch.id))!;
  const files = github.opened[0]?.files.map((f) => ('content' in f ? `${f.path}\n${f.content}` : `${f.path} (${f.bytes.length} bytes)`));
  return { ok: result.ok, status: after.status, detail: after.detail, files };
}

test('article: for the same answer the runner leaves the drafts and the launch as the old path does', async () => {
  const oldModel = jsonModel(pack);
  const old = await draft({ ai: new SdkProvider({ id: 'test', model: () => oldModel }) });
  const model = jsonModel(pack);
  const now = await draft({ ai: unused, aiRunner: mockRunner(model) });
  assert.equal(now.ok, true);
  assert.deepEqual(now, old);
  const call = model.doStreamCalls[0]!;
  assert.equal(call.responseFormat?.type, 'json', 'no repo: the answer comes in the response format');
  assert.equal(call.tools, undefined);
  assert.equal(JSON.stringify(call.prompt.filter((m) => m.role === 'user')), JSON.stringify(oldModel.doGenerateCalls[0]!.prompt.filter((m) => m.role === 'user')), 'the same prompt function');
});

test('article: on Claudio no workspace is made, and the settings’ budget is the run’s', async () => {
  const claudio = await fakeClaudio({ chat: (_, res) => claudioAnswer(res, JSON.stringify(pack)) });
  const gh = await fakeGitHubArchives();
  try {
    const now = await draft({ ai: unused, aiRunner: fakeClaudioRunner(claudio, gh), maxBudgetUsd: 1.5 });
    assert.equal(now.ok, true);
    assert.deepEqual(claudio.seen.map((s) => `${s.method} ${s.path}`), ['POST /api/v1/chat/completions']);
    assert.equal(claudioChats(claudio)[0]!.headers['x-claudio-max-budget-usd'], '1.5');
    assert.equal(gh.seen.length, 0, 'no archive asked for');
  } finally {
    await Promise.all([claudio.close(), gh.close()]);
  }
});

test('article: a refused call and an answer that stays invalid fail the launch with a readable problem', async () => {
  const claudio = await fakeClaudio({ chat: (_, res) => claudioRefusal(res, 401, 'invalid_api_key', 'bad token') });
  const gh = await fakeGitHubArchives();
  try {
    const refused = await draft({ ai: unused, aiRunner: fakeClaudioRunner(claudio, gh) });
    assert.equal(refused.ok, false);
    assert.equal(refused.status, 'failed');
    assert.match(refused.detail ?? '', /refused its credentials \(401\): reconnect the AI provider/);
    assert.doesNotMatch(refused.detail ?? '', /claudio-token/, 'no secret in the problem');
  } finally {
    await Promise.all([claudio.close(), gh.close()]);
  }
  const invalid = await draft({ ai: unused, aiRunner: mockRunner(scriptedModel(textParts('{"kind":"launch"}'))) });
  assert.equal(invalid.status, 'failed');
  assert.match(invalid.detail ?? '', /answer to article is not valid, even after a repair/);
});
