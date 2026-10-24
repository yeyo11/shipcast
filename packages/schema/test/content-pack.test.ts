import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  Brand,
  ContentPack,
  contentPackJsonSchema,
  graphemeCount,
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
  article: { slug: 'claudio-0-8', en: article, es: article },
  devto: { tags: ['claude', 'ai', 'typescript'] },
  bluesky: { lang: 'en', text: 'claudio runs Claude Code as a service.' },
  mastodon: { lang: 'en', text: 'claudio runs Claude Code as a service.' },
  instagram: { caption: 'Claude Code as a service. Link in bio. #claude #ai', media: 'og-image' },
  reddit: [{ subreddit: 'ClaudeAI', title: 'I built claudio', body: 'What and why.' }],
} as const;

const config = LaunchConfig.parse({ enabled: true, brand: 'personal', reddit: { subreddits: ['ClaudeAI'] } });
const brand = Brand.parse({ id: 'personal', displayName: 'Me', github: 'yeyo11' });

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

test('an Instagram caption carries no link and at most 30 hashtags', () => {
  const withLink = parse({ instagram: { caption: 'See https://example.com', media: 'og-image' } });
  assert.ok(!withLink.success);
  assert.match(withLink.error.issues[0]!.message, /link in bio/);
  const tags = Array.from({ length: 31 }, (_, i) => `#t${i}`).join(' ');
  assert.ok(!parse({ instagram: { caption: tags, media: 'og-image' } }).success);
});

test('dev.to takes at most four lowercase tags', () => {
  assert.ok(!parse({ devto: { tags: ['a', 'b', 'c', 'd', 'e'] } }).success);
  assert.ok(!parse({ devto: { tags: ['TypeScript'] } }).success);
});

test('the article needs a slug and at least one language', () => {
  assert.ok(!parse({ article: { slug: 'Not A Slug', en: article } }).success);
  assert.ok(!parse({ article: { slug: 'ok' } }).success);
});

test('missingPieces names what the enabled channels still need', () => {
  const { bluesky: _b, ...rest } = fullPack;
  const pack: Pack = ContentPack.parse({ ...rest, article: { slug: 'claudio-0-8', es: article }, reddit: [] });
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
  assert.ok(schema.required.includes('analysis'));
  assert.match(schema.properties.analysis?.description ?? '', /implemented list/);
});
