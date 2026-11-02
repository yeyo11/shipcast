import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Brand, ContentPack, LaunchConfig } from '@shipcast/schema';
import { buildActionPrompt } from '../src/assistant.ts';
import { renderIssueHtml } from '../src/newsletter.ts';
import { kindLanguage } from '../src/repositories/posts.ts';
import { LaunchRefused } from '../src/services/launches.ts';
import { renderDrafts, translationKeyOf, withScreenshot } from '../src/index.ts';
import { memoryRegistry } from '../src/testing.ts';

/*
 * A brand's blog languages (brand.yml's languages.blog) and what the engine writes from them: only
 * those languages' files, in any language, with the owner's English and Spanish as before.
 */

const brandOf = (blog: string[], lists?: Record<string, number>) =>
  Brand.parse({ id: 'acme', displayName: 'Acme', site: 'https://acme.dev', github: 'acme', languages: { blog }, ...(lists && { newsletter: { sender: { name: 'Acme', email: 'a@acme.dev' }, lists } }) });
const config = LaunchConfig.parse({ enabled: true, brand: 'acme', publishing: { newsletter: 'approval' } });
const registry = await memoryRegistry();
const launch = (await registry.launches.claim({ repo: 'acme/app', ref: 'v1.0.0', trigger: 'release', kind: 'launch', brand: 'acme' })).launch;

const version = (slug: string, title: string) => ({ slug, title, description: 'What it is.', markdown: 'First paragraph.\n\nSecond.' });
const issue = { subject: 'S', previewText: 'P', markdown: 'M' };
const pack = ContentPack.parse({
  schemaVersion: 1,
  kind: 'launch',
  project: { name: 'app', repo: 'https://github.com/acme/app', version: 'v1.0.0' },
  analysis: { summary: 'App.', implemented: ['It runs'], planned: [], documentedOnly: [], limitations: [] },
  article: { tags: [], en: version('app', 'App'), es: version('app-es', 'App ES'), fr: version('app-fr', 'App FR') },
  newsletter: { en: issue, es: issue, fr: issue },
});
const paths = (blog: string[], lists?: Record<string, number>) =>
  renderDrafts(pack, launch, config, brandOf(blog, lists), new Date('2026-11-02'))
    .map((f) => f.path)
    .filter((p) => p.startsWith('src/') || p.includes('newsletter-'));

test('only the brand’s languages are written, whatever else the pack holds', () => {
  assert.deepEqual(paths(['en'], { en: 1 }), ['src/content/posts/en/app.md', 'launches/app/v1.0.0/newsletter-en.md']);
  assert.deepEqual(paths(['en', 'es'], { en: 1, es: 2 }), ['src/content/posts/en/app.md', 'src/content/posts/es/app-es.md', 'launches/app/v1.0.0/newsletter-en.md', 'launches/app/v1.0.0/newsletter-es.md']);
  assert.deepEqual(paths(['fr', 'en'], { fr: 3 }), ['src/content/posts/fr/app-fr.md', 'src/content/posts/en/app.md', 'launches/app/v1.0.0/newsletter-fr.md'], 'the issues follow the lists, the articles the blog');
  assert.deepEqual(paths(['de']), [], 'a language the pack has no version in writes nothing for it');
});

test('the translation key is the English slug when there is one, else the primary language’s', () => {
  assert.equal(translationKeyOf(pack, brandOf(['en', 'es'])), 'app');
  assert.equal(translationKeyOf(pack, brandOf(['fr', 'en'])), 'app', 'English still pairs them, so adding a language never moves a key');
  const noEnglish = ContentPack.parse({ ...pack, article: { tags: [], es: version('app-es', 'ES'), fr: version('app-fr', 'FR') } });
  assert.equal(translationKeyOf(noEnglish, brandOf(['fr', 'es'])), 'app-fr');
  assert.equal(translationKeyOf(noEnglish, brandOf(['en', 'es'])), 'app-es', 'Spanish where it is the only one, as before');
});

test('the screenshot’s alt text and the issue’s fixed words are in the language, English when Shipcast has none', () => {
  assert.match(withScreenshot('A.\n\nB.', '/s.png', 'App', 'es'), /!\[App, captura de pantalla\]/);
  assert.match(withScreenshot('A.\n\nB.', '/s.png', 'App', 'fr'), /!\[App, capture d’écran\]/);
  assert.match(withScreenshot('A.\n\nB.', '/s.png', 'App', 'fi'), /!\[App, screenshot\]/);
  const html = (lang: 'en' | 'de' | 'fi') => renderIssueHtml(issue, { brand: brandOf([lang]), project: 'app', look: { colour: '#fff' }, title: 'T', articleUrl: 'https://acme.dev/x/', lang });
  assert.match(html('de'), /<html lang="de">[\s\S]*Artikel lesen/);
  assert.match(html('fi'), /<html lang="fi">[\s\S]*Read the article/);
});

test('the assistant translates into the brand’s other language', () => {
  const ask = (lang: string | undefined, blog: string[]) => buildActionPrompt({ action: 'translate', selection: 'Hola' }, { kind: 'launch', document: 'Hola', ...(lang && { lang }) } as never, brandOf(blog)).prompt;
  assert.match(ask('es', ['en', 'es']), /into English/);
  assert.match(ask('en', ['en', 'es']), /into Spanish/);
  assert.match(ask(undefined, ['en', 'es']), /into Spanish if it is in English, into English if it is in Spanish/);
  assert.match(ask('de', ['de', 'fr']), /into French/);
  assert.match(ask('en', ['en']), /into English/);
});

test('a post’s language is read from its kind in any language', () => {
  assert.equal(kindLanguage('article:fr'), 'fr');
  assert.equal(kindLanguage('issue:de'), 'de');
  assert.equal(kindLanguage('article:es'), 'es');
  assert.equal(kindLanguage('post'), undefined);
});

test('an article in a language the brand does not write in is refused before it is claimed', async () => {
  const { LaunchService } = await import('../src/services/launches.ts');
  const service = new LaunchService({ claims: { registry, launchesRepo: 'acme/launches' } } as never);
  await assert.rejects(service.claimArticle({ title: 'Hallo', markdown: 'Text', lang: 'de', channels: [] }, brandOf(['en', 'es'])), (error: unknown) => error instanceof LaunchRefused && /not written in German \(de\)/.test(error.message));
});
