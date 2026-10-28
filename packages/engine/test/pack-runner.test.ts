import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ANALYSIS_RULES, parseLaunchConfig } from '@shipcast/schema';
import { draftLaunch, generatePackOnRunner, loadBrand, type PipelineDeps } from '../src/index.ts';
import { SdkProvider } from '../src/legacy-ai.ts';
import {
  claudioAnswer,
  claudioChats,
  claudioRefusal,
  codeloadUrl,
  fakeClaudio,
  fakeClaudioRunner,
  fakeGitHubArchives,
  FakeGitHub,
  jsonModel,
  memoryRegistry,
  mockRunner,
  scriptedModel,
  submitParts,
  type FakeHandler,
} from '../src/testing/index.ts';

/*
 * The content pack on the AI task runner (`ai-runner`): for the same answer, the launch ends as the
 * old provider path leaves it (the same pull request, the same status and detail); a pack that falls
 * short, a provider that refuses and an answer that stays invalid fail the launch with a readable
 * problem and, on Claudio, the chat to read.
 */

const BRAND_YML = 'id: personal\ndisplayName: Me\nsite: https://josegarrido.dev\ngithub: yeyo11\n';
const LAUNCH_YML = 'enabled: true\nbrand: personal\npublishing:\n  instagram: off\n  reddit: off\n';

const article = { title: 'claudio', description: 'd', markdown: 'b' };
const pack = {
  schemaVersion: 1,
  kind: 'launch',
  project: { name: 'claudio', repo: 'https://github.com/yeyo11/claudio', version: 'v0.9.0' },
  analysis: { summary: 's', implemented: ['x'], planned: [], documentedOnly: [], limitations: [] },
  article: { en: { slug: 'claudio', ...article }, es: { slug: 'claudio-como-servicio', ...article } },
  devto: { tags: ['ai'] },
  bluesky: { lang: 'en', text: 'b' },
  mastodon: { lang: 'en', text: 'm' },
  githubDiscussions: { title: 'claudio 0.9', body: 'What shipped. https://josegarrido.dev/en/claudio/?ref=github' },
};

async function world(ai: Partial<Pick<PipelineDeps, 'ai' | 'aiRunner'>> & Partial<Pick<PipelineDeps, 'maxBudgetUsd' | 'aiTexts'>>) {
  const github = new FakeGitHub({
    files: { 'yeyo11/launches/brand.yml@HEAD': BRAND_YML, 'yeyo11/claudio/.github/launch.yml@v0.9.0': LAUNCH_YML },
    latestRelease: { tag: 'v0.9.0', url: 'u' },
  });
  const registry = await memoryRegistry();
  const hostPath = await mkdtemp(join(tmpdir(), 'shipcast-pack-'));
  const deps: PipelineDeps = {
    github,
    registry,
    launchesRepo: 'yeyo11/launches',
    checkout: async () => ({ hostPath, providerPath: '/workspace/x' }),
    now: () => new Date('2026-10-25T00:00:00Z'),
    fetch: (async () => new Response(null, { status: 404 })) as typeof fetch,
    ...ai,
  };
  const brand = await loadBrand(github, 'yeyo11/launches');
  const { launch } = await registry.launches.claim({ repo: 'yeyo11/claudio', ref: 'v0.9.0', trigger: 'release', kind: 'launch', brand: 'personal' });
  return { github, registry, deps, brand, launch, hostPath };
}

/** What a draft leaves: the launch's status and detail, and the pull request's files as text */
async function outcome(w: Awaited<ReturnType<typeof world>>) {
  const result = await draftLaunch(w.launch, w.brand, w.deps);
  const after = (await w.registry.launches.get(w.launch.id))!;
  const pr = w.github.opened[0];
  const files = pr?.files.map((f) => ('content' in f ? `${f.path}\n${f.content}` : `${f.path} (${f.bytes.length} bytes)`));
  return { ok: result.ok, status: after.status, detail: after.detail, branch: pr?.branch, title: pr?.title, files };
}

const userPrompt = (calls: ReadonlyArray<{ prompt: ReadonlyArray<{ role: string }> }>) => JSON.stringify(calls[0]!.prompt.filter((m) => m.role === 'user'));

test('pack: for the same answer the runner leaves the launch as the old path does, from the same prompt', async () => {
  const oldModel = jsonModel(pack);
  const old = await outcome(await world({ ai: new SdkProvider({ id: 'test', model: () => oldModel }) }));
  // Through the runner with the repo's tools, a provider answers through the submit tool
  const model = scriptedModel(submitParts(pack));
  const now = await outcome(await world({ aiRunner: mockRunner(model) }));
  assert.equal(now.ok, true);
  assert.deepEqual(now, old);
  assert.equal(now.status, 'drafted');
  assert.equal(userPrompt(model.doStreamCalls), userPrompt(oldModel.doGenerateCalls), 'the prompt is built by the same function');
  assert.ok((model.doStreamCalls[0]!.tools ?? []).some((t) => t.name === 'read_files'), 'the clone is read with the runner’s tools');
});

test('pack: a pack that falls short fails the launch with the problems, and Claudio’s chat to read', async () => {
  const claudio = await fakeClaudio({ chat: (_, res) => claudioAnswer(res, JSON.stringify({ ...pack, bluesky: undefined }), 'chat-41') });
  const gh = await fakeGitHubArchives();
  try {
    const w = await world({ aiRunner: fakeClaudioRunner(claudio, gh) });
    const result = await draftLaunch(w.launch, w.brand, w.deps);
    assert.equal(result.ok, false);
    assert.equal(w.github.opened.length, 0, 'no pull request for a pack that fails');
    const after = (await w.registry.launches.get(w.launch.id))!;
    assert.equal(after.status, 'failed');
    assert.match(after.detail ?? '', /bluesky: the pack has no bluesky\nclaudio chat: chat-41/);

    // The workspace was made from the release's codeload URL, the analysis rules declared, then released
    assert.deepEqual(claudio.seen.map((s) => `${s.method} ${s.path}`), ['POST /api/workspaces', 'POST /api/v1/chat/completions', 'DELETE /api/workspaces/ws-1']);
    assert.deepEqual(JSON.parse(claudio.seen[0]!.body), { url: codeloadUrl('yeyo11/claudio', 'v0.9.0') });
    const chat = claudioChats(claudio)[0]!;
    assert.deepEqual(JSON.parse(String(chat.headers['x-claudio-allowed-tools'])), [...ANALYSIS_RULES]);
    assert.equal(chat.headers['x-claudio-max-budget-usd'], '5', 'the pack task’s own budget without one in the settings');
  } finally {
    await Promise.all([claudio.close(), gh.close()]);
  }
});

test('pack: the settings’ budget is the run’s, as it was the old path’s, and their tone is the prompt’s', async () => {
  const claudio = await fakeClaudio({ chat: (_, res) => claudioAnswer(res, JSON.stringify(pack)) });
  const gh = await fakeGitHubArchives();
  try {
    const w = await world({ aiRunner: fakeClaudioRunner(claudio, gh), maxBudgetUsd: 2.5, aiTexts: async () => ({ tone: 'Dry and exact.' }) });
    assert.equal((await draftLaunch(w.launch, w.brand, w.deps)).ok, true);
    const chat = claudioChats(claudio)[0]!;
    assert.equal(chat.headers['x-claudio-max-budget-usd'], '2.5');
    assert.match(chat.body, /Dry and exact\./, 'the owner’s tone from the AI settings');
  } finally {
    await Promise.all([claudio.close(), gh.close()]);
  }
});

test('pack: a provider that refuses fails the launch with a readable problem, and the workspace is released', async () => {
  const refuse: FakeHandler = (_, res) => claudioRefusal(res, 429, 'rate_limit_exceeded', 'You have hit your session limit · resets 7:30pm');
  const claudio = await fakeClaudio({ chat: refuse });
  const gh = await fakeGitHubArchives();
  try {
    const w = await world({ aiRunner: fakeClaudioRunner(claudio, gh) });
    const result = await draftLaunch(w.launch, w.brand, w.deps);
    assert.equal(result.ok, false);
    const after = (await w.registry.launches.get(w.launch.id))!;
    assert.equal(after.status, 'failed');
    assert.match(after.detail ?? '', /usage limit.*session limit/);
    assert.ok(claudio.seen.some((s) => s.method === 'DELETE'), 'the workspace is released after a failure');
  } finally {
    await Promise.all([claudio.close(), gh.close()]);
  }
});

test('pack: an answer still invalid after its repair fails the launch with what is wrong', async () => {
  const model = scriptedModel(submitParts({ kind: 'launch' }), submitParts({ kind: 'launch' }, 'call-2'));
  const w = await world({ aiRunner: mockRunner(model) });
  const result = await draftLaunch(w.launch, w.brand, w.deps);
  assert.equal(result.ok, false);
  assert.equal(model.doStreamCalls.length, 2, 'one answer and one repair');
  assert.match((await w.registry.launches.get(w.launch.id))!.detail ?? '', /answer to pack is not valid, even after a repair: .*project/);
});

test('pack: without a runner the old provider still drafts it: the flag off is today', async () => {
  const model = jsonModel(pack);
  const w = await world({ ai: new SdkProvider({ id: 'test', model: () => model }) });
  assert.equal((await draftLaunch(w.launch, w.brand, w.deps)).ok, true);
  assert.equal(model.doGenerateCalls.length, 1);
  assert.equal(model.doStreamCalls.length, 0);
});

test('pack: the generation carries Claudio’s chat id and the turn’s cost, as the old path’s result did', async () => {
  const claudio = await fakeClaudio({ chat: (_, res) => claudioAnswer(res, JSON.stringify(pack), 'chat-9') });
  const gh = await fakeGitHubArchives();
  try {
    const w = await world({});
    const parsed = parseLaunchConfig(LAUNCH_YML);
    assert.ok(parsed.ok);
    const generated = await generatePackOnRunner({ runner: fakeClaudioRunner(claudio, gh), launch: w.launch, config: parsed.value, brand: w.brand, checkout: { hostPath: w.hostPath, providerPath: '' }, ref: 'v0.9.0' });
    assert.equal(generated.ok, true);
    assert.equal(generated.chatId, 'chat-9');
    assert.equal(generated.costUsd, 0.12, 'usage.cost_usd, through providerMetadata.claudio.costUsd');
  } finally {
    await Promise.all([claudio.close(), gh.close()]);
  }
});
