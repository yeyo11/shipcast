import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  Brand,
  ContentPack,
  contentPackJsonSchema,
  graphemeCount,
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
} as const;

// Reddit is off by default; turned on here so its drafts are still checked
const config = LaunchConfig.parse({ enabled: true, brand: 'personal', publishing: { reddit: 'manual' }, reddit: { subreddits: ['ClaudeAI'] } });
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

test('a channel without a connector yet cannot be turned on silently', () => {
  const withX = LaunchConfig.parse({ enabled: true, brand: 'personal', publishing: { x: 'manual' } });
  assert.ok(missingPieces(ContentPack.parse(fullPack), withX, brand).includes('x: no connector yet; set it to off in launch.yml'));
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
  hackerNews: { title: 'Show HN: claudio, Claude Code as a service', firstComment: 'I built it because...' },
  productHunt: { tagline: 'Claude Code as a service', description: 'Run Claude Code from anywhere.', firstComment: 'Hi, I made it.' },
};

test('the phase 5 pieces are valid within their limits and invalid beyond them', () => {
  assert.ok(parse(phase5).success);
  assert.ok(!parse({ hashnode: { tags: [] } }).success);
  assert.ok(!parse({ hashnode: { tags: ['a', 'b', 'c', 'd', 'e', 'f'] } }).success);
  assert.ok(!parse({ hashnode: { tags: ['Claude'] } }).success);
  assert.ok(parse({ telegram: { text: 'a'.repeat(LIMITS.telegramText) } }).success);
  assert.ok(!parse({ telegram: { text: 'a'.repeat(LIMITS.telegramText + 1) } }).success);
  assert.ok(!parse({ discord: { text: 'a'.repeat(LIMITS.discordText + 1) } }).success);
  assert.ok(!parse({ hackerNews: { ...phase5.hackerNews, title: `Show HN: ${'a'.repeat(80)}` } }).success);
  assert.ok(!parse({ hackerNews: { ...phase5.hackerNews, title: 'claudio' } }).success, 'must start with Show HN');
  assert.ok(!parse({ hackerNews: { ...phase5.hackerNews, firstComment: 'a'.repeat(2001) } }).success);
  assert.ok(!parse({ productHunt: { ...phase5.productHunt, tagline: 'a'.repeat(61) } }).success);
  assert.ok(!parse({ productHunt: { ...phase5.productHunt, description: 'a'.repeat(261) } }).success);
  assert.ok(!parse({ productHunt: { ...phase5.productHunt, firstComment: 'a'.repeat(1001) } }).success);
});

test('missingPieces requires each phase 5 piece once its channel is on', () => {
  const on = LaunchConfig.parse({
    enabled: true,
    brand: 'personal',
    publishing: { hashnode: 'approval', telegram: 'approval', discord: 'approval', hackerNews: 'manual', productHunt: 'manual' },
  });
  assert.deepEqual(missingPieces(ContentPack.parse({ ...fullPack, reddit: undefined, ...phase5 }), on, brand), []);
  assert.deepEqual(missingPieces(ContentPack.parse({ ...fullPack, reddit: undefined }), on, brand), [
    'hackerNews: the pack has no hackerNews',
    'hashnode: the pack has no hashnode',
    'productHunt: the pack has no productHunt',
    'telegram: the pack has no telegram',
    'discord: the pack has no discord',
  ]);
});

test('Hacker News and Product Hunt are draft-only: auto and approval are refused', () => {
  for (const channel of ['hackerNews', 'productHunt']) {
    assert.ok(!LaunchConfig.safeParse({ enabled: true, brand: 'personal', publishing: { [channel]: 'approval' } }).success);
    assert.ok(LaunchConfig.safeParse({ enabled: true, brand: 'personal', publishing: { [channel]: 'manual' } }).success);
  }
});
