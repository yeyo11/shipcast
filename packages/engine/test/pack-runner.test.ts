import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ANALYSIS_RULES, parseLaunchConfig } from '@shipcast/schema';
import { buildPrompt, draftLaunch, generatePack, loadBrand, type PipelineDeps } from '../src/index.ts';
import {
  claudioAnswer,
  claudioChats,
  claudioRefusal,
  codeloadUrl,
  fakeClaudio,
  fakeClaudioRunner,
  fakeGitHubArchives,
  FakeGitHub,
  memoryRegistry,
  mockRunner,
  scriptedModel,
  submitParts,
  type FakeHandler,
} from '../src/testing/index.ts';

/*
 * The content pack on the AI task runner: a good answer ends as the drafts pull request, from the
 * prompt buildPrompt writes; a pack that falls short, a provider that refuses and an answer that stays
 * invalid fail the launch with a readable problem and, on Claudio, the chat to read.
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

async function world(ai: Pick<PipelineDeps, 'aiRunner'> & Partial<Pick<PipelineDeps, 'aiTexts'>>) {
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
    checkout: async () => ({ hostPath }),
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

test('pack: a good answer ends as the drafts pull request, from the prompt buildPrompt writes', async () => {
  // Through the runner with the repo's tools, a provider answers through the submit tool
  const model = scriptedModel(submitParts(pack));
  const w = await world({ aiRunner: mockRunner(model) });
  const now = await outcome(w);
  assert.equal(now.ok, true);
  assert.equal(now.status, 'drafted');
  assert.equal(now.detail, 'https://github.com/yeyo11/launches/pull/1');
  assert.equal(now.branch, 'launch/claudio-v0.9.0');
  assert.equal(now.title, 'Launch claudio v0.9.0');
  assert.ok(now.files?.some((f) => f.startsWith('launches/claudio/v0.9.0/pack.json\n')), 'the pack travels with the drafts');
  const parsed = parseLaunchConfig(LAUNCH_YML);
  assert.ok(parsed.ok);
  const { prompt } = buildPrompt(w.launch, parsed.value, w.brand);
  assert.ok(JSON.stringify(model.doStreamCalls[0]!.prompt).includes(JSON.stringify(prompt).slice(1, -1)), 'the prompt is buildPrompt’s');
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

test('pack: the owner’s limit for the pack is the run’s budget, and their tone is the prompt’s', async () => {
  const claudio = await fakeClaudio({ chat: (_, res) => claudioAnswer(res, JSON.stringify(pack)) });
  const gh = await fakeGitHubArchives();
  try {
    const w = await world({ aiRunner: fakeClaudioRunner(claudio, gh, [], { pack: 2.5, article: 9 }), aiTexts: async () => ({ tone: 'Dry and exact.' }) });
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

test('pack: the generation carries Claudio’s chat id and the turn’s cost', async () => {
  const claudio = await fakeClaudio({ chat: (_, res) => claudioAnswer(res, JSON.stringify(pack), 'chat-9') });
  const gh = await fakeGitHubArchives();
  try {
    const w = await world({ aiRunner: fakeClaudioRunner(claudio, gh) });
    const parsed = parseLaunchConfig(LAUNCH_YML);
    assert.ok(parsed.ok);
    const generated = await generatePack({ runner: w.deps.aiRunner, launch: w.launch, config: parsed.value, brand: w.brand, checkout: { hostPath: w.hostPath }, ref: 'v0.9.0' });
    assert.equal(generated.ok, true);
    assert.equal(generated.chatId, 'chat-9');
    assert.equal(generated.costUsd, 0.12, 'usage.cost_usd, through providerMetadata.claudio.costUsd');
  } finally {
    await Promise.all([claudio.close(), gh.close()]);
  }
});
