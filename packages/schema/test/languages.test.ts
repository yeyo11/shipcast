import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  aiContentPack,
  AI_TASK_DEFINITIONS,
  Brand,
  ContentPack,
  contentPackJsonSchema,
  isLanguage,
  LANGUAGE_NAMES,
  languageName,
  languagesOf,
  LaunchConfig,
  leadLanguage,
  missingPieces,
  newsletterLanguages,
  packLanguages,
  packTaskFor,
  parseBrand,
  SOURCES_PACK_TASK,
  sourcesPackJsonSchema,
} from '../src/index.ts';

// The map the engine's article prompt and assistant each had, and the MCP prompt's ternary

test('a language is named in English, and a code Shipcast does not know is written as it came', () => {
  assert.equal(LANGUAGE_NAMES.en, 'English');
  assert.equal(languageName('en'), 'English');
  assert.equal(languageName('es'), 'Spanish');
  assert.equal(languageName('fr'), 'French');
  assert.equal(languageName('de'), 'German');
  assert.equal(languageName('xx'), 'xx');
  assert.equal(languageName(''), '');
});

const brandYml = (languages: string) => `id: acme\ndisplayName: Acme\nsite: https://acme.dev\ngithub: acme\n${languages}`;

test('a new brand writes its blog in English alone, and may name any ISO 639-1 codes, in order', () => {
  const plain = parseBrand(brandYml(''));
  assert.ok(plain.ok);
  assert.deepEqual(plain.value.languages.blog, ['en']);
  const three = parseBrand(brandYml('languages:\n  blog: [de, en, fr]\n'));
  assert.ok(three.ok);
  assert.deepEqual(three.value.languages.blog, ['de', 'en', 'fr'], 'the order is kept: the first is the primary language');
});

test('a language that is not two lowercase letters is refused, as is one listed twice', () => {
  for (const junk of ['EN', 'eng', 'e', 'en-US', '"12"', 'español']) {
    const result = parseBrand(brandYml(`languages:\n  blog: [${junk}]\n`));
    assert.ok(!result.ok, junk);
    assert.match(result.issues[0]?.path ?? '', /^languages\.blog/);
  }
  assert.ok(!parseBrand(brandYml('languages:\n  blog: [en, en]\n')).ok);
  assert.ok(!parseBrand(brandYml('languages:\n  blog: [en]\n  linkedin: EN\n')).ok);
  assert.ok(isLanguage('fr'));
  assert.ok(!isLanguage('fra'));
  assert.ok(!isLanguage(undefined));
});

const version = (slug: string) => ({ slug, title: 'Acme', description: 'What it is.', markdown: 'Body.' });
const pack = (article: Record<string, unknown>, newsletter?: Record<string, unknown>) => ({
  schemaVersion: 1,
  kind: 'launch',
  project: { name: 'acme', repo: 'https://github.com/acme/acme' },
  analysis: { summary: 'Acme.', implemented: ['It runs'], planned: [], documentedOnly: [], limitations: [] },
  article,
  ...(newsletter && { newsletter }),
});

test('a kept pack takes an article and an issue in any language, and refuses a key that is not one', () => {
  const kept = ContentPack.parse(pack({ tags: ['x'], de: version('acme'), fr: version('acme-fr') }, { de: { subject: 'S', previewText: 'P', markdown: 'M' } }));
  assert.equal(kept.article?.de?.slug, 'acme');
  assert.deepEqual(languagesOf(kept.article), ['de', 'fr'], 'the tags are not a language');
  assert.ok(!ContentPack.safeParse(pack({ tags: [], english: version('acme') })).success, 'a key that is not a language code');
  assert.ok(!ContentPack.safeParse(pack({ tags: [], EN: version('acme') })).success);
  assert.ok(!ContentPack.safeParse(pack({ tags: [] })).success, 'at least one language');
  assert.ok(!ContentPack.safeParse(pack({ tags: [], en: { slug: 'x' } })).success, 'a version is still checked');
});

test("the pack the AI is asked for names exactly the brand's languages", () => {
  const props = (schema: Record<string, unknown>, piece: string) =>
    Object.keys((schema as { properties: Record<string, { properties: Record<string, unknown> }> }).properties[piece]!.properties);
  const english = contentPackJsonSchema({ blog: ['en'], newsletter: ['en'] });
  assert.deepEqual(props(english, 'article'), ['tags', 'en']);
  assert.deepEqual(props(english, 'newsletter'), ['en']);
  assert.deepEqual(props(contentPackJsonSchema({ blog: ['de', 'fr'], newsletter: ['de'] }), 'article'), ['tags', 'de', 'fr']);
  assert.deepEqual(props(contentPackJsonSchema(), 'article'), ['tags', 'en', 'es'], 'the task definitions ask for English and Spanish, as before');
  assert.deepEqual(props(sourcesPackJsonSchema({ blog: ['fr'], newsletter: ['fr'] }), 'article'), ['tags', 'fr']);
  assert.ok(!aiContentPack({ blog: ['en'], newsletter: ['en'] }).safeParse(pack({ tags: [], en: version('a'), es: version('b') })).success, 'a language the brand does not write in');
  assert.equal(aiContentPack({ blog: ['en'], newsletter: ['en'] }), aiContentPack({ blog: ['en'], newsletter: ['en'] }), 'made once per set');

  const task = packTaskFor(AI_TASK_DEFINITIONS.pack, { blog: ['de'], newsletter: ['de'] });
  assert.deepEqual(props(task.output!.jsonSchema(), 'article'), ['tags', 'de']);
  assert.ok(task.output!.schema.safeParse(pack({ tags: [], de: version('a') })).success);
  assert.deepEqual(props(packTaskFor(SOURCES_PACK_TASK, { blog: ['it'], newsletter: ['it'] }).output!.jsonSchema(), 'article'), ['tags', 'it']);
  assert.equal(packTaskFor(AI_TASK_DEFINITIONS.profile, { blog: ['de'], newsletter: ['de'] }), AI_TASK_DEFINITIONS.profile, 'a task with no pack is left as it is');
});

test("the newsletter's languages are its lists', the blog's order first; the blog's without a newsletter", () => {
  const brand = Brand.parse({ id: 'b', displayName: 'B', site: 'https://b.dev', github: 'b', languages: { blog: ['es', 'en'] }, newsletter: { sender: { name: 'B', email: 'b@b.dev' }, lists: { en: 1, fr: 3, es: 2 } } });
  assert.deepEqual(newsletterLanguages(brand), ['es', 'en', 'fr']);
  assert.deepEqual(packLanguages(brand), { blog: ['es', 'en'], newsletter: ['es', 'en', 'fr'] });
  assert.deepEqual(newsletterLanguages({ ...brand, newsletter: undefined }), ['es', 'en']);
});

test('the lead language is English when the article has it, else the primary one it has', () => {
  const brand = (blog: string[]) => Brand.parse({ id: 'b', displayName: 'B', site: 'https://b.dev', github: 'b', languages: { blog } });
  assert.equal(leadLanguage({ tags: [], en: {}, es: {} }, brand(['en', 'es'])), 'en');
  assert.equal(leadLanguage({ tags: [], es: {} }, brand(['en', 'es'])), 'es', 'Spanish where it is the only one, as before');
  assert.equal(leadLanguage({ tags: [], en: {}, de: {} }, brand(['de', 'en'])), 'en');
  assert.equal(leadLanguage({ tags: [], fr: {}, de: {} }, brand(['de', 'fr'])), 'de');
  assert.equal(leadLanguage(undefined, brand(['de'])), undefined);
});

test('dev.to and Hashnode want the English article from a brand that writes in English, else the primary one', () => {
  const config = LaunchConfig.parse({ enabled: true, brand: 'b', publishing: { devto: 'approval', hashnode: 'approval' } });
  const brand = (blog: string[]) => Brand.parse({ id: 'b', displayName: 'B', site: 'https://b.dev', github: 'b', languages: { blog } });
  const full = (article: Record<string, unknown>) => ContentPack.parse({ ...pack(article), devto: { tags: ['x'] }, hashnode: { tags: ['x'] } });
  const german = full({ tags: [], de: version('acme') });
  assert.deepEqual(missingPieces(german, config, brand(['de'])).filter((m) => /^(devto|hashnode)/.test(m)), []);
  assert.deepEqual(missingPieces(german, config, brand(['de', 'en'])).filter((m) => /^(devto|hashnode)/.test(m)), [
    'devto: dev.to republishes the English article, which is missing',
    'hashnode: Hashnode republishes the English article, which is missing',
  ]);
  assert.ok(missingPieces(full({ tags: [], en: version('acme') }), config, brand(['fr'])).includes('devto: dev.to republishes the French article, which is missing'));
  assert.ok(missingPieces(german, config, brand(['de', 'fr'])).includes('blog: the article has no fr version'));
});
