import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Brand, LaunchConfig } from '@shipcast/schema';
import { ANALYSIS_TOOLS, buildPrompt, generatePack, Registry, type AiProvider, type GenerateRequest, type Launch } from '../src/index.ts';

const brand = Brand.parse({
  id: 'personal',
  displayName: 'José Antonio Garrido',
  site: 'https://josegarrido.dev',
  github: 'yeyo11',
  tone: 'First person, didactic and direct.',
});
const config = LaunchConfig.parse({
  enabled: true,
  brand: 'personal',
  assets: { demo: 'docs/media/tour.gif' },
  // Reddit is off by default; turned on here so its brief is still checked
  publishing: { reddit: 'manual' },
  reddit: { subreddits: ['ClaudeAI', 'selfhosted'] },
});

function launch(kind: Launch['kind'] = 'launch'): Launch {
  const registry = new Registry(':memory:');
  return registry.claim({ repo: 'yeyo11/claudio', ref: 'v0.9.0', trigger: 'release', kind, brand: 'personal' }).launch;
}

const article = { title: 'claudio', description: 'Claude Code as a service.', markdown: 'Body.' };
const goodPack = {
  schemaVersion: 1,
  kind: 'launch',
  project: { name: 'claudio', repo: 'https://github.com/yeyo11/claudio', version: 'v0.9.0' },
  analysis: { summary: 's', implemented: ['REST API'], planned: [], documentedOnly: [], limitations: [] },
  article: { en: { slug: 'claudio', ...article }, es: { slug: 'claudio-como-servicio', ...article } },
  devto: { tags: ['claude', 'ai'] },
  bluesky: { lang: 'en', text: 'claudio https://josegarrido.dev/en/claudio/?ref=bluesky' },
  mastodon: { lang: 'en', text: 'claudio #claude https://josegarrido.dev/en/claudio/?ref=mastodon' },
  instagram: { caption: 'claudio. Link in bio. #claude', summary: 'Claude Code as a service.', slides: [{ title: 'Chats', text: 'From anywhere.' }, { title: 'Agents', text: 'In parallel.' }] },
  reddit: [
    { subreddit: 'ClaudeAI', title: 'claudio', body: 'b' },
    { subreddit: 'selfhosted', title: 'claudio', body: 'b' },
  ],
};

class FakeAi implements AiProvider {
  requests: GenerateRequest[] = [];
  answer: unknown;
  constructor(answer: unknown) {
    this.answer = answer;
  }
  async generate(request: GenerateRequest) {
    this.requests.push(request);
    if (this.answer instanceof Error) throw this.answer;
    return { output: this.answer, chatId: 'chat-1', costUsd: 0.5 };
  }
}

const checkout = { hostPath: '/tmp/x', providerPath: '/workspace/yeyo11__claudio@v0.9.0' };

test('the prompt carries the brand, the truth rule, the pack and one brief per active channel', () => {
  const { prompt, system } = buildPrompt(launch(), config, brand);
  assert.match(system, /José Antonio Garrido/);
  assert.match(system, /First person, didactic and direct\./);
  assert.match(system, /The code is the source of truth/);
  assert.match(prompt, /yeyo11\/claudio at v0\.9\.0/);
  assert.match(prompt, /first launch/);
  assert.match(prompt, /https:\/\/josegarrido\.dev\/<lang>\/<that slug>\//);
  assert.match(prompt, /r\/ClaudeAI, r\/selfhosted/);
  assert.match(prompt, /the demo plays as its second slide/, "a repo with a demo gets it in the carousel");
  assert.match(prompt, /no URL/);
  assert.doesNotMatch(prompt, /linkedin|\bx:/i, 'channels that are off get no brief');
});

test('a valid, complete pack is accepted, and the request is read-only and schema-bound', async () => {
  const ai = new FakeAi(goodPack);
  const result = await generatePack({ ai, launch: launch(), config, brand, checkout, maxBudgetUsd: 3 });
  assert.equal(result.ok, true);
  const request = ai.requests[0]!;
  assert.equal(request.cwd, '/workspace/yeyo11__claudio@v0.9.0');
  assert.deepEqual(request.allowedTools, ANALYSIS_TOOLS);
  assert.ok(!request.allowedTools.some((t) => /Write|Edit|Bash\(\*|^Bash$/.test(t)), 'the analysis cannot change the repo');
  assert.equal((request.jsonSchema as { type: string }).type, 'object');
  assert.equal(request.maxBudgetUsd, 3);
});

test('a pack that breaks the schema is refused with the paths of the problems', async () => {
  const result = await generatePack({ ai: new FakeAi({ ...goodPack, bluesky: { lang: 'en', text: 'x'.repeat(400) } }), launch: launch(), config, brand, checkout });
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.problems.some((p) => p.startsWith('bluesky.text:')));
  assert.equal(!result.ok && result.chatId, 'chat-1');
});

test('a pack for the wrong launch, or missing a piece, is refused', async () => {
  const { reddit: _r, ...noReddit } = goodPack;
  const result = await generatePack({
    ai: new FakeAi({ ...noReddit, kind: 'minor', project: { ...goodPack.project, repo: 'https://github.com/yeyo11/other' } }),
    launch: launch(),
    config,
    brand,
    checkout,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(!result.ok && result.problems, [
    'kind is "minor", the launch is "launch"',
    'project.repo is https://github.com/yeyo11/other, the launch is yeyo11/claudio',
    'reddit: the pack has no reddit',
  ]);
});

test('a provider failure becomes a refused pack with its message and chat id', async () => {
  const error = Object.assign(new Error('claudio chat failed: rate limit'), { chatId: 'chat-9' });
  const result = await generatePack({ ai: new FakeAi(error), launch: launch(), config, brand, checkout });
  assert.deepEqual(result, { ok: false, problems: ['claudio chat failed: rate limit'], chatId: 'chat-9' });
});
