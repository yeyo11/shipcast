import assert from 'node:assert/strict';
import { test } from 'node:test';
import { articleConfig, buildArticlePrompt, claimArticle, draftArticle, loadBrand, type PipelineDeps } from '../src/index.ts';
import { claudioAnswer, claudioChats, claudioRefusal, fakeClaudio, fakeClaudioRunner, fakeGitHubArchives, FakeGitHub, jsonModel, memoryRegistry, mockRunner, scriptedModel, textParts } from '../src/testing/index.ts';

/*
 * An article on the AI task runner: the answer becomes the drafts with the owner's own words; no repo
 * is read, so Claudio gets no workspace; a failure fails the launch with a readable problem.
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

async function draft(ai: Pick<PipelineDeps, 'aiRunner'> & Partial<Pick<PipelineDeps, 'maxBudgetUsd'>>) {
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
  return { ok: result.ok, status: after.status, detail: after.detail, files, brand };
}

test('article: the answer becomes the drafts with the owner’s own words, from the prompt buildArticlePrompt writes', async () => {
  const model = jsonModel(pack);
  const now = await draft({ aiRunner: mockRunner(model) });
  assert.equal(now.ok, true);
  assert.equal(now.status, 'drafted');
  assert.equal(now.detail, 'https://github.com/yeyo11/launches/pull/1');
  const en = now.files?.find((f) => f.startsWith('src/content/posts/en/claudio.md\n'));
  assert.match(en ?? '', /title: "My own title"[\s\S]*My own words\./, 'the owner’s words, not the AI’s copy of them');
  assert.ok(now.files?.some((f) => f.startsWith('src/content/posts/es/claudio-es.md\n')), 'the translation the AI wrote');
  assert.ok(now.files?.some((f) => f.startsWith('articles/my-own-title/bluesky.md\n')));
  const call = model.doStreamCalls[0]!;
  assert.equal(call.responseFormat?.type, 'json', 'no repo: the answer comes in the response format');
  assert.equal(call.tools, undefined);
  const { prompt } = buildArticlePrompt(input, now.brand, articleConfig(now.brand, input.channels), 'yeyo11/launches', {});
  assert.ok(JSON.stringify(call.prompt).includes(JSON.stringify(prompt).slice(1, -1)), 'the prompt is buildArticlePrompt’s');
});

test('article: on Claudio no workspace is made, and the settings’ budget is the run’s', async () => {
  const claudio = await fakeClaudio({ chat: (_, res) => claudioAnswer(res, JSON.stringify(pack)) });
  const gh = await fakeGitHubArchives();
  try {
    const now = await draft({ aiRunner: fakeClaudioRunner(claudio, gh), maxBudgetUsd: 1.5 });
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
    const refused = await draft({ aiRunner: fakeClaudioRunner(claudio, gh) });
    assert.equal(refused.ok, false);
    assert.equal(refused.status, 'failed');
    assert.match(refused.detail ?? '', /refused its credentials \(401\): reconnect the AI provider/);
    assert.doesNotMatch(refused.detail ?? '', /claudio-token/, 'no secret in the problem');
  } finally {
    await Promise.all([claudio.close(), gh.close()]);
  }
  const invalid = await draft({ aiRunner: mockRunner(scriptedModel(textParts('{"kind":"launch"}'))) });
  assert.equal(invalid.status, 'failed');
  assert.match(invalid.detail ?? '', /answer to article is not valid, even after a repair/);
});
