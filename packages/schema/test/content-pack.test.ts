import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AI_TASK_DEFINITIONS,
  AiContentPack,
  AiSourcesPack,
  Brand,
  ContentPack,
  pieceLimitProblem,
  contentPackJsonSchema,
  SOURCES_PACK_TASK,
  sourcesPackJsonSchema,
  graphemeCount,
  DEFAULT_MODES,
  threadsLength,
  LIMITS,
  LaunchConfig,
  missingPieces,
  type ContentPack as Pack,
} from '../src/index.ts';

const article = { title: 'claudio', description: 'Claude Code as a service.', markdown: 'Body.' };

const fullPack = {
  schemaVersion: 1,
  kind: 'launch',
  project: { name: 'claudio', repo: 'https://github.com/yeyo11/claudio', version: 'v0.8.1' },
  analysis: {
    summary: 'Claude Code as a service.',
    implemented: ['REST API'],
    planned: ['macOS app'],
    documentedOnly: [],
    limitations: ['One provider'],
  },
  article: { en: { slug: 'claudio-0-8', ...article }, es: { slug: 'claudio-0-8-como-servicio', ...article } },
  devto: { tags: ['claude', 'ai', 'typescript'] },
  bluesky: { lang: 'en', text: 'claudio runs Claude Code as a service.' },
  mastodon: { lang: 'en', text: 'claudio runs Claude Code as a service.' },
  instagram: { caption: 'Claude Code as a service. Link in bio. #claude #ai', summary: 'Claude Code as a service.', slides: [{ title: 'Chats', text: 'From anywhere.' }, { title: 'Agents', text: 'In parallel.' }] },
  reddit: [{ subreddit: 'ClaudeAI', title: 'I built claudio', body: 'What and why.' }],
  // On by default: the GitHub App posts it, with no account to connect
  githubDiscussions: { title: 'claudio 0.8.1', body: 'What shipped. https://example.dev/en/claudio-0-8/?ref=github' },
} as const;

// Reddit is off by default; turned on here so its posts are still checked
const config = LaunchConfig.parse({ enabled: true, brand: 'personal', publishing: { reddit: 'approval' }, reddit: { subreddits: ['ClaudeAI'] } });
const brand = Brand.parse({ id: 'personal', displayName: 'Me', site: 'https://example.dev', github: 'yeyo11' });

function parse(overrides: Record<string, unknown>) {
  return ContentPack.safeParse({ ...fullPack, ...overrides });
}

test('a full pack for the MVP channels is valid and complete', () => {
  const pack = ContentPack.parse(fullPack);
  assert.deepEqual(missingPieces(pack, config, brand), []);
});

test('the analysis must list at least one implemented feature', () => {
  const result = parse({ analysis: { ...fullPack.analysis, implemented: [] } });
  assert.ok(!result.success);
});

test('Bluesky counts graphemes, not UTF-16 units', () => {
  assert.equal(graphemeCount('👩‍💻'), 1);
  assert.equal(graphemeCount('é'), 1);
  assert.ok(parse({ bluesky: { lang: 'en', text: '👩‍💻'.repeat(300) } }).success);
  assert.ok(!parse({ bluesky: { lang: 'en', text: 'a'.repeat(301) } }).success);
});

test('Mastodon stops at 500 characters', () => {
  assert.ok(!parse({ mastodon: { lang: 'en', text: 'a'.repeat(501) } }).success);
});

test('an Instagram caption carries no link and at most 5 hashtags', () => {
  const withLink = parse({ instagram: { caption: 'See https://example.com', summary: 'Claude Code as a service.', slides: [{ title: 'Chats', text: 'From anywhere.' }, { title: 'Agents', text: 'In parallel.' }] } });
  assert.ok(!withLink.success);
  assert.match(withLink.error.issues[0]!.message, /link in bio/);
  const tags = Array.from({ length: 6 }, (_, i) => `#t${i}`).join(' ');
  assert.ok(!parse({ instagram: { caption: tags, summary: 'Claude Code as a service.', slides: [{ title: 'Chats', text: 'From anywhere.' }, { title: 'Agents', text: 'In parallel.' }] } }).success);
});

test('dev.to takes at most four lowercase tags', () => {
  assert.ok(!parse({ devto: { tags: ['a', 'b', 'c', 'd', 'e'] } }).success);
  assert.ok(!parse({ devto: { tags: ['TypeScript'] } }).success);
});

test('each language of the article needs its own slug, and there is at least one language', () => {
  assert.ok(!parse({ article: { en: { slug: 'Not A Slug', ...article } } }).success);
  assert.ok(!parse({ article: { en: article } }).success);
  assert.ok(!parse({ article: {} }).success);
});

test('missingPieces names what the enabled channels still need', () => {
  const { bluesky: _b, ...rest } = fullPack;
  const pack: Pack = ContentPack.parse({ ...rest, article: { es: { slug: 'claudio-0-8', ...article } }, reddit: [] });
  assert.deepEqual(missingPieces(pack, config, brand), [
    'bluesky: the pack has no bluesky',
    'blog: the article has no en version',
    'devto: dev.to republishes the English article, which is missing',
    'reddit: no draft for r/ClaudeAI',
  ]);
});

test('the JSON Schema for Claude is an object schema that keeps the field descriptions', () => {
  const schema = contentPackJsonSchema() as {
    type: string;
    properties: Record<string, { description?: string }>;
    required: string[];
  };
  assert.equal(schema.type, 'object');
  assert.equal((schema as { $schema?: string }).$schema, 'http://json-schema.org/draft-07/schema#', 'Claude Code refuses draft 2020-12');
  assert.ok(schema.required.includes('analysis'));
  assert.match(schema.properties.analysis?.description ?? '', /implemented list/);
});

test('the newsletter needs a list in brand.yml and an issue for each list', () => {
  const config = LaunchConfig.parse({ enabled: true, brand: 'personal', publishing: { newsletter: 'approval' }, reddit: { subreddits: ['ClaudeAI'] } });
  const issue = { subject: 'claudio is out', previewText: 'Claude Code as a service', markdown: 'It shipped.' };
  const plain = Brand.parse({ id: 'personal', displayName: 'Me', site: 'https://josegarrido.dev', github: 'yeyo11' });
  const withLists = Brand.parse({
    id: 'personal',
    displayName: 'Me',
    site: 'https://josegarrido.dev',
    github: 'yeyo11',
    newsletter: { sender: { name: 'Me', email: 'hola@josegarrido.dev' }, lists: { en: 3, es: 4 } },
  });
  const pack = ContentPack.parse({ ...fullPack, newsletter: { en: issue } });
  assert.ok(missingPieces(pack, config, plain).includes('newsletter: brand.yml has no newsletter'));
  assert.ok(missingPieces(pack, config, withLists).includes('newsletter: the issue has no es version'));
  assert.ok(!ContentPack.safeParse({ ...fullPack, newsletter: {} }).success, 'at least one language');
  assert.ok(!Brand.safeParse({ ...withLists, newsletter: { sender: { name: 'Me', email: 'nope' }, lists: { en: 3 } } }).success);
});

const phase5 = {
  hashnode: { tags: ['claude', 'ai'] },
  telegram: { text: 'claudio runs Claude Code as a service. https://example.dev/en/claudio-0-8/?ref=telegram' },
  discord: { text: 'claudio runs Claude Code as a service. https://example.dev/en/claudio-0-8/?ref=discord' },
};

test('the phase 5 pieces are valid within their limits and invalid beyond them', () => {
  assert.ok(parse(phase5).success);
  assert.ok(!parse({ hashnode: { tags: [] } }).success);
  assert.ok(!parse({ hashnode: { tags: ['a', 'b', 'c', 'd', 'e', 'f'] } }).success);
  assert.ok(!parse({ hashnode: { tags: ['Claude'] } }).success);
  assert.ok(parse({ telegram: { text: 'a'.repeat(LIMITS.telegramText) } }).success);
  assert.ok(!parse({ telegram: { text: 'a'.repeat(LIMITS.telegramText + 1) } }).success);
  assert.ok(!parse({ discord: { text: 'a'.repeat(LIMITS.discordText + 1) } }).success);
  assert.ok(!parse({ hackerNews: { title: 'Show HN: claudio', firstComment: 'I built it' } }).success, 'Hacker News is no piece of the pack');
});

test('missingPieces requires each phase 5 piece once its channel is on', () => {
  const on = LaunchConfig.parse({
    enabled: true,
    brand: 'personal',
    publishing: { hashnode: 'approval', telegram: 'approval', discord: 'approval' },
  });
  assert.deepEqual(missingPieces(ContentPack.parse({ ...fullPack, reddit: undefined, ...phase5 }), on, brand), []);
  assert.deepEqual(missingPieces(ContentPack.parse({ ...fullPack, reddit: undefined }), on, brand), [
    'hashnode: the pack has no hashnode',
    'telegram: the pack has no telegram',
    'discord: the pack has no discord',
  ]);
});

test('only channels Shipcast publishes on itself exist: Hacker News, Product Hunt and X are refused', () => {
  for (const channel of ['hackerNews', 'productHunt', 'x']) {
    assert.ok(!LaunchConfig.safeParse({ enabled: true, brand: 'personal', publishing: { [channel]: 'off' } }).success, channel);
  }
});

test('GitHub Discussions is on by default; Threads and LinkedIn stay off until turned on', () => {
  assert.equal(DEFAULT_MODES.githubDiscussions, 'approval');
  assert.equal(DEFAULT_MODES.threads, 'off');
  assert.equal(DEFAULT_MODES.linkedin, 'off');
  const plain = LaunchConfig.parse({ enabled: true, brand: 'personal' });
  const { githubDiscussions: _g, ...rest } = fullPack;
  assert.ok(missingPieces(ContentPack.parse(rest), plain, brand).includes('githubDiscussions: the pack has no githubDiscussions'));
});

test('the new networks’ pieces are valid within their limits and invalid beyond them', () => {
  assert.ok(parse({ threads: { text: 'a'.repeat(LIMITS.threadsText) } }).success);
  assert.ok(!parse({ threads: { text: 'a'.repeat(LIMITS.threadsText + 1) } }).success);
  // Threads counts an emoji as its UTF-8 bytes: 125 rockets are 500, one more is too many
  assert.equal(threadsLength('🚀 a'), 6);
  assert.ok(parse({ threads: { text: '🚀'.repeat(125) } }).success);
  assert.ok(!parse({ threads: { text: '🚀'.repeat(126) } }).success);
  assert.ok(parse({ linkedin: { text: 'a'.repeat(LIMITS.linkedinText) } }).success);
  assert.ok(!parse({ linkedin: { text: 'a'.repeat(LIMITS.linkedinText + 1) } }).success);
  assert.ok(!parse({ githubDiscussions: { title: 'a'.repeat(LIMITS.githubDiscussionTitle + 1), body: 'b' } }).success);
  assert.ok(!parse({ githubDiscussions: { title: 't' } }).success, 'a discussion needs its body');
});

test('missingPieces requires each new piece once its channel is on, and an article for LinkedIn to share', () => {
  const on = LaunchConfig.parse({ enabled: true, brand: 'personal', publishing: { reddit: 'approval', threads: 'approval', linkedin: 'approval' }, reddit: { subreddits: ['ClaudeAI'] } });
  assert.deepEqual(missingPieces(ContentPack.parse(fullPack), on, brand), ['linkedin: the pack has no linkedin', 'threads: the pack has no threads']);
  const { article: _a, ...noArticle } = fullPack;
  const pack = ContentPack.parse({ ...noArticle, threads: { text: 't' }, linkedin: { text: 'l' } });
  const blogOff = LaunchConfig.parse({ enabled: true, brand: 'personal', publishing: { blog: 'off', devto: 'off', threads: 'approval', linkedin: 'approval' } });
  assert.deepEqual(missingPieces(pack, blogOff, brand), ['linkedin: LinkedIn shares the article, which is missing']);
});

test('a piece is measured against its network the way that network counts', () => {
  assert.equal(pieceLimitProblem('bluesky', 'é'.repeat(300)), undefined, 'Bluesky counts graphemes');
  assert.match(pieceLimitProblem('bluesky', 'a'.repeat(301)) ?? '', /^Bluesky takes at most 300 characters \(the link included\); this is 301$/);
  assert.match(pieceLimitProblem('threads', `${'a'.repeat(497)}🔎`) ?? '', /this is 501/, 'an emoji is its UTF-8 bytes on Threads');
  assert.equal(pieceLimitProblem('linkedin', 'a'.repeat(1300)), undefined);
  assert.equal(pieceLimitProblem('devto', 'a'.repeat(99_999)), undefined, 'an article has no cap here');
});

test('a pack may be about no repo, or name further repos besides the primary one', () => {
  const { repo: _repo, ...noRepo } = fullPack.project;
  assert.ok(ContentPack.safeParse({ ...fullPack, project: noRepo }).success, 'a product, a talk or an opinion has no repo');
  const several = ContentPack.parse({ ...fullPack, project: { ...fullPack.project, repos: ['https://github.com/yeyo11/claudio-app'] } });
  assert.deepEqual(several.project.repos, ['https://github.com/yeyo11/claudio-app']);
  assert.ok(!ContentPack.safeParse({ ...fullPack, project: { ...fullPack.project, repos: ['not a url'] } }).success);
});

test('the AI tasks are still asked for a pack with its repo and no further repos, as before the launch model', () => {
  const { repo: _repo, ...noRepo } = fullPack.project;
  assert.ok(!AiContentPack.safeParse({ ...fullPack, project: noRepo }).success);
  assert.ok(!AiContentPack.safeParse({ ...fullPack, project: { ...fullPack.project, repos: [] } }).success);
  assert.equal(AI_TASK_DEFINITIONS.pack.output?.schema, AiContentPack);
  assert.equal(AI_TASK_DEFINITIONS.article.output?.schema, AiContentPack);
  const project = (contentPackJsonSchema() as { properties: { project: { required: string[]; properties: Record<string, unknown> } } }).properties.project;
  assert.deepEqual(project.required, ['name', 'repo']);
  assert.deepEqual(Object.keys(project.properties), ['name', 'repo', 'version']);
});

test('a launch made from sources is asked for claims, each naming the sources that show it', () => {
  const { repo: _repo, ...noRepo } = fullPack.project;
  const claims = [{ text: 'it runs Claude Code as a service', sources: ['S1', 'S2'] }];
  const withClaims = { ...fullPack, project: noRepo, analysis: { ...fullPack.analysis, claims } };
  assert.ok(AiSourcesPack.safeParse(withClaims).success, 'no repo, with claims');
  assert.ok(!AiSourcesPack.safeParse({ ...withClaims, analysis: fullPack.analysis }).success, 'claims are required there');
  assert.ok(!AiSourcesPack.safeParse({ ...withClaims, analysis: { ...fullPack.analysis, claims: [{ text: 'x', sources: [] }] } }).success, 'a claim cites a source');
  assert.ok(!AiSourcesPack.safeParse({ ...withClaims, analysis: { ...fullPack.analysis, claims: [{ text: 'x', sources: ['the README'] }] } }).success, 'by its id');
  assert.ok(ContentPack.safeParse(withClaims).success, 'every pack it accepts is a ContentPack');
  assert.ok(!AiContentPack.safeParse({ ...fullPack, analysis: { ...fullPack.analysis, claims } }).success, 'the pack of a release is asked for nothing new');
  assert.equal(SOURCES_PACK_TASK.output?.schema, AiSourcesPack);
  assert.equal(SOURCES_PACK_TASK.id, 'pack', 'the pack’s settings, ceilings and budget');
  const analysis = (sourcesPackJsonSchema() as { properties: { analysis: { required: string[] } } }).properties.analysis;
  assert.ok(analysis.required.includes('claims'));
  const legacy = (contentPackJsonSchema() as { properties: { analysis: { properties: Record<string, unknown> } } }).properties.analysis;
  assert.ok(!('claims' in legacy.properties), 'what Claude is handed for a release is unchanged');
});
