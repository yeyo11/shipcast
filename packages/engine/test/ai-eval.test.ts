import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Brand, parseLaunchConfig } from '@shipcast/schema';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import { compareEvals, evalSettings, listDiff, loadEvalCases, readEvalDir, runEval, summarizeArgs, withAccess, type EvalRecord } from '../src/ai/eval.ts';
import { aiProvider, anthropicAiProvider, AiTaskRunner, claudioAiProvider, openaiCompatibleAiProvider, fakePack, SUBMIT_TOOL, type AiProviderDefinition, type Launch } from '../src/index.ts';

/*
 * The evaluation harness without a provider: the real cases file loads, a run goes through the
 * AiTaskRunner on a MockLanguageModel over a temp checkout, and two runs compare. Nothing here
 * reaches a network.
 */

type StreamPart = Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer P> ? P : never;
type StreamOptions = Parameters<MockLanguageModelV4['doStream']>[0];

const usage = { inputTokens: { total: 10, noCache: 4, cacheRead: 6, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
const finish = (reason: 'stop' | 'tool-calls') => ({ type: 'finish' as const, finishReason: { unified: reason, raw: undefined }, usage });
const toolCall = (toolName: string, input: unknown, id = `call-${toolName}`): StreamPart[] => [{ type: 'tool-call', toolCallId: id, toolName, input: JSON.stringify(input) }, finish('tool-calls')];

function scripted(...scripts: Array<StreamPart[] | (() => StreamPart[])>): MockLanguageModelV4 {
  let next = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const script = scripts[Math.min(next++, scripts.length - 1)]!;
      return { stream: convertArrayToReadableStream(typeof script === 'function' ? script() : script) };
    },
  });
}

function mockProvider(model: MockLanguageModelV4): AiProviderDefinition {
  return aiProvider({
    id: 'mock',
    name: 'mock provider',
    listed: false,
    settings: [{ key: 'apiKey', label: 'API key', secret: true }],
    capabilities: { streaming: true, tools: true, structuredOutput: 'native', repoAccess: 'local-tools' },
    defaultModel: () => 'mock-model',
    model: () => model,
  });
}

const brand = Brand.parse({ id: 'personal', displayName: 'Me', site: 'https://example.dev', github: 'me' });
const LAUNCH_YML = 'enabled: true\nbrand: personal\npublishing:\n  blog: off\n  devto: off\n  instagram: off\n  githubDiscussions: off\n  mastodon: off\n';

async function demoRepo(withLaunchYml = true): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'shipcast-eval-repo-'));
  await mkdir(join(repo, '.github'));
  await mkdir(join(repo, 'src'));
  if (withLaunchYml) await writeFile(join(repo, '.github', 'launch.yml'), LAUNCH_YML);
  await writeFile(join(repo, 'README.md'), '# Demo\n');
  await writeFile(join(repo, 'src', 'main.ts'), 'export const answer = 42;\n');
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: repo });
  git('init', '--quiet');
  git('add', '.');
  git('commit', '--quiet', '-m', 'feat: first');
  return repo;
}

test('the real cases file loads: three cases, the reply grounded in the claudio pack, the inline launch.yml valid today', async () => {
  const path = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'scripts', 'ai-eval.cases.json');
  const file = loadEvalCases(await readFile(path, 'utf8'));
  assert.deepEqual(
    file.cases.map((c) => [c.id, c.task, c.repo, c.ref]),
    [
      ['shipcast-v0.1.0-pack', 'pack', 'yeyo11/shipcast', 'v0.1.0'],
      ['claudio-v0.9.0-pack', 'pack', 'yeyo11/claudio', 'v0.9.0'],
      ['claudio-v0.9.0-reply-conflict', 'reply', 'yeyo11/claudio', 'v0.9.0'],
    ],
  );
  const shipcast = file.cases[0]!;
  assert.ok(shipcast.task === 'pack' && shipcast.launchYml && parseLaunchConfig(shipcast.launchYml).ok);
  const reply = file.cases[2]!;
  assert.ok(reply.task === 'reply' && reply.analysisFrom === 'claudio-v0.9.0-pack' && /conflict/.test(reply.comment.text));
});

test('a cases file with a repeated id or a reply grounded in no earlier pack is refused, every problem named', () => {
  const bad = {
    brand: { repo: 'me/launches' },
    cases: [
      { id: 'a', task: 'pack', repo: 'me/x', ref: 'v1' },
      { id: 'a', task: 'pack', repo: 'me/x', ref: 'v2' },
      { id: 'r', task: 'reply', repo: 'me/x', ref: 'v1', channel: 'bluesky', comment: { author: 'x', text: 'y' }, analysisFrom: 'later' },
    ],
  };
  assert.throws(() => loadEvalCases(JSON.stringify(bad)), /cases\.1\.id: a is used twice; cases\.2\.analysisFrom: later is not a pack case before this one/);
  assert.throws(() => loadEvalCases('{'), /not JSON/);
});

test('a run goes through the AI task runner and records the answer, steps, tool calls, time and tokens per case', async () => {
  const repo = await demoRepo();
  const config = parseLaunchConfig(LAUNCH_YML);
  assert.ok(config.ok);
  const launch: Launch = { id: 0, repo: 'me/demo', ref: 'v1.0.0', trigger: 'manual', kind: 'launch', brand: 'personal', status: 'generating', detail: null, createdAt: '', updatedAt: '' };
  const pack = { ...fakePack(launch, config.value, brand), analysis: { summary: 'Demo answers 42.', implemented: ['the answer'], planned: [], documentedOnly: [], limitations: ['no questions'] } };
  const model = scripted(
    toolCall('read_files', { files: [{ path: 'README.md' }, { path: 'src/main.ts', from: 1, to: 5 }] }),
    toolCall(SUBMIT_TOOL, pack),
    toolCall('search', { pattern: 'answer', context: 2 }, 'call-search-2'),
    toolCall(SUBMIT_TOOL, { classification: 'question', language: 'en', dismiss: false, reply: 'It answers 42.', reason: 'a question' }, 'call-submit-2'),
  );
  const provider = mockProvider(model);
  const setup = { provider, settings: { apiKey: 'k' }, model: '' };
  const runner = new AiTaskRunner({ resolve: async () => setup });
  const outDir = join(await mkdtemp(join(tmpdir(), 'shipcast-eval-out-')), 'run');
  const cloned: string[] = [];
  let now = 0;
  const records = await runEval(
    [
      { id: 'demo-pack', task: 'pack', repo: 'me/demo', ref: 'v1.0.0' },
      { id: 'demo-reply', task: 'reply', repo: 'me/demo', ref: 'v1.0.0', channel: 'bluesky', comment: { author: 'someone', text: 'What is the answer?' }, thread: [], post: { text: 'Demo v1.0.0' }, analysisFrom: 'demo-pack' },
    ],
    {
      runner,
      setup,
      brand,
      outDir,
      checkout: async (r, ref) => (cloned.push(`${r}@${ref}`), repo),
      clock: () => (now += 1500),
    },
  );
  assert.deepEqual(cloned, ['me/demo@v1.0.0'], 'one clone per repo and ref');
  const [packRecord, replyRecord] = records;
  assert.equal(packRecord?.ok, true, packRecord?.error);
  assert.deepEqual(packRecord.toolCalls, [
    { name: 'read_files', args: 'README.md, src/main.ts:1-5' },
    { name: SUBMIT_TOOL, args: '(the answer)' },
  ]);
  assert.equal(packRecord.steps, 2);
  assert.deepEqual(packRecord.usage, { inputTokens: 20, outputTokens: 10, totalTokens: 30, cacheReadTokens: 12, cacheWriteTokens: 0 });
  assert.equal(packRecord.wallMs, 1500);
  assert.deepEqual(packRecord.problems, []);
  assert.equal(packRecord.access, 'local-tools');
  assert.equal(packRecord.model, 'mock-model');

  assert.equal(replyRecord?.ok, true, replyRecord?.error);
  assert.deepEqual(replyRecord.output, { classification: 'question', language: 'en', dismiss: false, reply: 'It answers 42.', reason: 'a question' });
  assert.deepEqual(replyRecord.toolCalls[0], { name: 'search', args: '{"pattern":"answer","context":2,"mode":"content"}' }, 'the input as the tool took it, its defaults filled in');

  const firstPrompt = JSON.stringify(model.doStreamCalls[0]!.prompt);
  assert.match(firstPrompt, /Launch me\/demo at v1\.0\.0/, 'the pack prompt is buildPrompt’s');
  const replyPrompt = JSON.stringify(model.doStreamCalls[2]!.prompt);
  assert.match(replyPrompt, /Someone commented on your Bluesky post/, 'the reply prompt is buildReplyPrompt’s');
  assert.match(replyPrompt, /Summary: Demo answers 42\./, 'grounded in the pack case’s analysis');

  assert.deepEqual(JSON.parse(await readFile(join(outDir, 'demo-pack.json'), 'utf8')), JSON.parse(JSON.stringify(packRecord)));
  assert.equal((await readEvalDir(outDir)).length, 2, 'summary.json lists every case');
});

test('a case that fails is recorded with its error, the provider’s secret taken out, and the run goes on', async () => {
  const noConfig = await demoRepo(false);
  const failing = new MockLanguageModelV4({
    doStream: async () => {
      throw new Error('the server said: bad key sekret-123456');
    },
  });
  const setup = { provider: mockProvider(failing), settings: { apiKey: 'sekret-123456' }, model: '' };
  const runner = new AiTaskRunner({ resolve: async () => setup });
  const records = await runEval(
    [
      { id: 'no-config', task: 'pack', repo: 'me/demo', ref: 'v1' },
      { id: 'failing', task: 'reply', repo: 'me/demo', ref: 'v1', channel: 'bluesky', comment: { author: 'x', text: 'y' }, thread: [], post: {} },
    ],
    { runner, setup, brand, outDir: await mkdtemp(join(tmpdir(), 'shipcast-eval-out-')), checkout: async () => noConfig },
  );
  assert.match(records[0]!.error ?? '', /has no \.github\/launch\.yml: give the case a launchYml/);
  assert.equal(records[1]!.ok, false);
  assert.match(records[1]!.error ?? '', /bad key \*\*\*/);
  assert.doesNotMatch(JSON.stringify(records), /sekret-123456/);
});

test('settings come from the environment by field, and the access override changes only how the repo is reached', () => {
  const env = { SHIPCAST_EVAL_PROVIDER_URL: 'http://claudio:3000', SHIPCAST_EVAL_PROVIDER_TOKEN: 't0k3n', SHIPCAST_EVAL_PROVIDER_BASE_URL: 'http://llm:8080/v1' };
  assert.deepEqual(evalSettings(claudioAiProvider, env), { url: 'http://claudio:3000', token: 't0k3n' });
  assert.equal(evalSettings(openaiCompatibleAiProvider, env).baseUrl, 'http://llm:8080/v1', 'a field of its own wins over the shared URL');
  assert.deepEqual(evalSettings(anthropicAiProvider, env), { apiKey: 't0k3n' });
  const local = withAccess(claudioAiProvider, 'local-tools');
  assert.equal(local.capabilities.repoAccess, 'local-tools');
  assert.equal(claudioAiProvider.capabilities.repoAccess, 'remote-workspace', 'the registry’s definition is left as it is');
  assert.equal(withAccess(claudioAiProvider, undefined), claudioAiProvider);
  assert.equal(summarizeArgs('git', { command: 'log', range: 'v0.8.1..v0.9.0' }), '{"command":"log","range":"v0.8.1..v0.9.0"}');
  assert.ok(summarizeArgs('search', { pattern: 'x'.repeat(1000) }).length <= 301);
});

const record = (over: Partial<EvalRecord> & { case: string }): EvalRecord => ({
  task: 'pack',
  repo: 'me/demo',
  ref: 'v1',
  provider: 'anthropic',
  model: 'claude-opus-5-5',
  access: 'local-tools',
  ok: true,
  problems: [],
  steps: 5,
  repaired: false,
  toolCalls: [],
  wallMs: 66_000,
  usage: { inputTokens: 100_000, outputTokens: 8000, totalTokens: 108_000, cacheReadTokens: 80_000, cacheWriteTokens: 0 },
  ...over,
});
const analysis = (implemented: string[], limitations: string[]) => ({ analysis: { summary: 'Demo.', implemented, planned: [], documentedOnly: [], limitations } });

test('two runs compare: steps, time and tokens side by side, and the analysis items added and removed', async () => {
  const a = [
    record({ case: 'pack', output: analysis(['Watches releases', 'Drafts a PR'], ['No Windows']), toolCalls: [{ name: 'read_files', args: 'x' }] }),
    record({ case: 'reply', task: 'reply', output: { classification: 'question', dismiss: false, reply: 'Last write wins today.' }, wallMs: 20_000 }),
  ];
  const b = [
    record({ case: 'pack', steps: 12, wallMs: 98_000, access: 'remote-workspace', provider: 'claudio', output: analysis(['watches  releases', 'Publishes to Bluesky'], ['No Windows']) }),
    record({ case: 'reply', task: 'reply', ok: false, error: 'ai_timeout' }),
  ];
  const dirA = await mkdtemp(join(tmpdir(), 'shipcast-eval-a-'));
  const dirB = await mkdtemp(join(tmpdir(), 'shipcast-eval-b-'));
  await writeFile(join(dirA, 'summary.json'), JSON.stringify(a));
  await writeFile(join(dirB, 'summary.json'), JSON.stringify(b));
  const out = compareEvals(await readEvalDir(dirA), await readEvalDir(dirB));
  assert.match(out, /^A: anthropic claude-opus-5-5, local-tools\nB: claudio claude-opus-5-5, remote-workspace\n/);
  assert.match(out, /\| pack +\| 5 +\| 12 +\| 1 +\| 0 +\| 66\.0 s +\| 98\.0 s +\| 108k +\| 108k +\| 80k +\| 80k +\|/);
  assert.match(out, /\| reply +\| 5 +\| failed +\|/);
  assert.match(out, /## pack\nimplemented: 2 → 2\n {2}- Drafts a PR\n {2}\+ Publishes to Bluesky\nplanned: 0 → 0, the same items\ndocumentedOnly: 0 → 0, the same items\nlimitations: 1 → 1, the same items/);
  assert.match(out, /## reply\nB failed: ai_timeout/);
  assert.deepEqual(listDiff(['A thing', 'Other'], ['a  THING', 'New']), { added: ['New'], removed: ['Other'] });
});
