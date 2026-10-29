import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { draftLaunch, FAKE_NOTICE, fakePack, loadBrand, writeAiSettings, type PipelineDeps } from '@shipcast/engine';
import { FakeGitHub, memoryRegistry, mockRunner, scriptedModel, submitParts } from '@shipcast/engine/testing';
import type { CiAi } from '@shipcast/runtime';
import { parseLaunchConfig } from '@shipcast/schema';
import { aiLabelOf, ciPipeline } from '../src/ci.ts';

/*
 * What Action mode does with the AI the environment chose (SHIPCAST_AI_PROVIDER and its keys): the
 * label a run prints, the draft the fake provider leaves, the message when no AI is configured, and
 * the request each real provider is sent. None of it calls a network: the providers' requests are
 * answered here.
 */

const BRAND_YML = 'id: personal\ndisplayName: Me\nsite: https://example.dev\ngithub: me\n';
const LAUNCH_YML = 'enabled: true\nbrand: personal\npublishing:\n  instagram: off\n  reddit: off\n';
const NO_AI = 'no AI provider is configured (SHIPCAST_AI_PROVIDER, anthropic or openai, with ANTHROPIC_API_KEY or OPENAI_API_KEY)';

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A release of me/app with its launch.yml, claimed, and a clone of it on disk as the Action's checkout leaves it */
async function world() {
  const github = new FakeGitHub({
    files: { 'me/launches/brand.yml@HEAD': BRAND_YML, 'me/app/.github/launch.yml@v1.0.0': LAUNCH_YML },
    latestRelease: { tag: 'v1.0.0', url: 'u' },
  });
  const registry = await memoryRegistry();
  const hostPath = mkdtempSync(join(tmpdir(), 'shipcast-ci-ai-'));
  dirs.push(hostPath);
  mkdirSync(join(hostPath, '.github'));
  writeFileSync(join(hostPath, '.github', 'launch.yml'), LAUNCH_YML);
  const base = {
    github,
    registry,
    launchesRepo: 'me/launches',
    // The SDK providers read the clone on this machine: the provider's view is the host's
    checkout: async () => ({ hostPath }),
    now: () => new Date('2026-10-29T00:00:00Z'),
    fetch: (async () => new Response(null, { status: 404 })) as typeof fetch,
  } satisfies Partial<PipelineDeps>;
  const brand = await loadBrand(github, 'me/launches');
  const { launch } = await registry.launches.claim({ repo: 'me/app', ref: 'v1.0.0', trigger: 'release', kind: 'launch', brand: 'personal' });
  return { github, registry, base, brand, launch };
}

type World = Awaited<ReturnType<typeof world>>;

/** What a draft leaves: the launch's status and detail, and the pull request's files as text */
async function draftOn(w: World, pipeline: PipelineDeps) {
  const result = await draftLaunch(w.launch, w.brand, pipeline);
  const stored = (await w.registry.launches.get(w.launch.id))!;
  const pr = w.github.opened[0];
  const files = pr?.files.map((f) => ('content' in f ? `${f.path}\n${f.content}` : `${f.path} (${f.bytes.length} bytes)`));
  return { ok: result.ok, problems: result.ok ? [] : result.problems, status: stored.status, detail: stored.detail, branch: pr?.branch, title: pr?.title, body: pr?.body, files };
}

test('the label a run prints for each AI the environment chooses', () => {
  const labels = ([undefined, { kind: 'anthropic', apiKey: 'k', model: undefined }, { kind: 'anthropic', apiKey: 'k', model: 'claude-sonnet-5-5' }, { kind: 'openai', apiKey: 'k', model: undefined }, { kind: 'openaiCompatible', baseUrl: 'http://localhost:11434/v1', apiKey: undefined, model: 'qwen3' }, { kind: 'fake' }] satisfies Array<CiAi | undefined>).map(aiLabelOf);
  assert.deepEqual(labels, [
    'the AI (none configured)',
    'the Anthropic API (claude-opus-5-5)',
    'the Anthropic API (claude-sonnet-5-5)',
    'the OpenAI API (gpt-5.5)',
    'http://localhost:11434/v1 (qwen3)',
    'the fake AI provider (a placeholder pack, for tests: no model reads the code)',
  ]);
});

test('fake: the draft is the placeholder pack of the launch it was asked for, read from the clone’s launch.yml', async () => {
  const fake = await world();
  const drafted = await draftOn(fake, ciPipeline({ kind: 'fake' }, fake.base, { launch: fake.launch, brand: fake.brand }));
  assert.equal(drafted.ok, true, drafted.problems.join('; '));
  assert.equal(drafted.status, 'drafted');
  assert.equal(drafted.title, 'Launch app v1.0.0');
  assert.ok(drafted.files?.some((f) => f.includes(FAKE_NOTICE)), 'every piece says no model wrote it');

  // The same pull request as a model answering fakePack itself would open
  const config = parseLaunchConfig(LAUNCH_YML);
  assert.ok(config.ok);
  const reference = await world();
  const model = scriptedModel(submitParts(fakePack(reference.launch, config.value, reference.brand)));
  assert.deepEqual(drafted, await draftOn(reference, { ...reference.base, aiRunner: mockRunner(model) }));
});

test('no AI configured (a dry run): a draft fails the launch with what to set, and opens nothing', async () => {
  const w = await world();
  const drafted = await draftOn(w, ciPipeline(undefined, w.base, { launch: w.launch, brand: w.brand }));
  assert.deepEqual([drafted.ok, drafted.problems, drafted.status, drafted.detail, drafted.files], [false, [NO_AI], 'failed', NO_AI, undefined]);
});

test('fake: a pipeline without a launch (publishing) has no AI to draft with', async () => {
  const w = await world();
  const drafted = await draftOn(w, ciPipeline({ kind: 'fake' }, w.base));
  assert.deepEqual([drafted.ok, drafted.problems, drafted.status], [false, [NO_AI], 'failed']);
});

interface Sent {
  url: string;
  headers: Headers;
  body: string;
}

/** The process's fetch answering every provider call with a refusal, recording what was sent */
async function withRefusingFetch(run: (sent: Sent[]) => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  const sent: Sent[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    sent.push({ url, headers: new Headers(init?.headers), body: typeof init?.body === 'string' ? init.body : '' });
    return new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid key' } }), { status: 401, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    await run(sent);
  } finally {
    globalThis.fetch = original;
  }
}

/**
 * Each provider is called where its variables say, with its key and model, and the owner's tone from
 * the registry; the AI settings' choice of provider (claudio here) is the server's and is ignored.
 */
for (const [name, ai, url, auth, model] of [
  ['anthropic', { kind: 'anthropic', apiKey: 'sk-ant', model: undefined }, 'https://api.anthropic.com/v1/messages', ['x-api-key', 'sk-ant'], 'claude-opus-5-5'],
  ['anthropic with a model', { kind: 'anthropic', apiKey: 'sk-ant', model: 'claude-sonnet-5-5' }, 'https://api.anthropic.com/v1/messages', ['x-api-key', 'sk-ant'], 'claude-sonnet-5-5'],
  ['openai', { kind: 'openai', apiKey: 'sk-oa', model: undefined }, 'https://api.openai.com/v1/responses', ['authorization', 'Bearer sk-oa'], 'gpt-5.5'],
  ['openai-compatible', { kind: 'openaiCompatible', baseUrl: 'http://models.test/v1/', apiKey: 'sk-c', model: 'qwen3' }, 'http://models.test/v1/chat/completions', ['authorization', 'Bearer sk-c'], 'qwen3'],
] as const satisfies ReadonlyArray<readonly [string, CiAi, string, readonly [string, string], string]>) {
  test(`${name}: the provider is asked with the environment's key and model, and the owner's tone`, async () => {
    const w = await world();
    await writeAiSettings(w.registry, { tasks: { pack: { provider: 'claudio' }, article: { provider: 'claudio' }, assistant: { provider: 'claudio' } }, tone: 'Dry and exact.' });
    await withRefusingFetch(async (sent) => {
      const drafted = await draftOn(w, ciPipeline(ai, w.base, { launch: w.launch, brand: w.brand }));
      assert.equal(drafted.ok, false);
      assert.equal(drafted.status, 'failed');
      assert.equal(drafted.files, undefined);
      const call = sent[0];
      assert.ok(call, 'the provider was called');
      assert.equal(call.url, url);
      assert.equal(call.headers.get(auth[0]), auth[1]);
      assert.equal((JSON.parse(call.body) as { model: string }).model, model);
      assert.match(call.body, /Dry and exact\./);
    });
  });
}
