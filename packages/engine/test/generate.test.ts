import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Brand, LaunchConfig } from '@shipcast/schema';
import { buildPrompt, generatePack, type Launch } from '../src/index.ts';
import { mockRunner, scriptedModel, submitParts } from '../src/testing/index.ts';

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
  publishing: { reddit: 'approval' },
  reddit: { subreddits: ['ClaudeAI', 'selfhosted'] },
});

function launch(kind: Launch['kind'] = 'launch'): Launch {
  const at = '2026-10-25T00:00:00.000Z';
  return { id: 1, repo: 'yeyo11/claudio', ref: 'v0.9.0', trigger: 'release', kind, brand: 'personal', status: 'detected', detail: null, createdAt: at, updatedAt: at };
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
  githubDiscussions: { title: 'claudio 0.9', body: 'What shipped. https://josegarrido.dev/en/claudio/?ref=github' },
  instagram: { caption: 'claudio. Link in bio. #claude', summary: 'Claude Code as a service.', slides: [{ title: 'Chats', text: 'From anywhere.' }, { title: 'Agents', text: 'In parallel.' }] },
  reddit: [
    { subreddit: 'ClaudeAI', title: 'claudio', body: 'b' },
    { subreddit: 'selfhosted', title: 'claudio', body: 'b' },
  ],
};

const checkout = { hostPath: '/tmp/x', providerPath: '/workspace/yeyo11__claudio@v0.9.0' };

/** The pack generated on a runner whose model answers `answer` through the submit tool */
async function generated(answer: unknown) {
  const model = scriptedModel(submitParts(answer));
  const result = await generatePack({ runner: mockRunner(model), launch: launch(), config, brand, checkout, ref: 'v0.9.0' });
  return { result, model };
}

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

test('a valid, complete pack is accepted, and the clone is read with read-only tools only', async () => {
  const { result, model } = await generated(goodPack);
  assert.equal(result.ok, true);
  const tools = (model.doStreamCalls[0]!.tools ?? []).map((t) => t.name).sort();
  assert.deepEqual(tools, ['git', 'list_files', 'read_files', 'repo_overview', 'search', 'submit_answer'], 'the analysis cannot change the repo');
});

test('a pack for the wrong launch, or missing a piece, is refused', async () => {
  const { reddit: _r, ...noReddit } = goodPack;
  const { result } = await generated({ ...noReddit, kind: 'minor', project: { ...goodPack.project, repo: 'https://github.com/yeyo11/other' } });
  assert.equal(result.ok, false);
  assert.deepEqual(!result.ok && result.problems, [
    'kind is "minor", the launch is "launch"',
    'project.repo is https://github.com/yeyo11/other, the launch is yeyo11/claudio',
    'reddit: the pack has no reddit',
  ]);
});

test('the prompt briefs the phase 5 channels when they are on', () => {
  const on = LaunchConfig.parse({
    enabled: true,
    brand: 'personal',
    publishing: { hashnode: 'approval', telegram: 'approval', discord: 'approval' },
  });
  const { prompt } = buildPrompt(launch(), on, brand);
  assert.match(prompt, /hashnode: 1 to 5 lowercase tags/);
  assert.match(prompt, /telegram: one post in English, at most 900 characters.*\?ref=telegram/);
  assert.match(prompt, /discord: one message in English, at most 1800 characters.*\?ref=discord/);
  assert.doesNotMatch(prompt, /hackerNews|productHunt|Show HN/);
});
