import assert from 'node:assert/strict';
import { test } from 'node:test';
import { langName, langOf, langsOf, piecesOf } from '../src/components/approve/model.ts';
import { langOfDraft, translateLabel } from '../src/components/assistant/protocol.ts';

/*
 * The app's language switches (the drafts editor's, the preview's) come from the drafts' paths, in
 * whatever languages the brand writes: one language shows no switch.
 */

const D = 'launches/app/v1.0.0';

test('a draft’s language is read from its path, in any language, and from nothing else', () => {
  assert.equal(langOf('src/content/posts/fr/app-lancement.md'), 'fr');
  assert.equal(langOf('src/content/posts/es/claudio.md'), 'es');
  assert.equal(langOf(`${D}/newsletter-de.md`), 'de');
  assert.equal(langOfDraft(`${D}/newsletter-pt.md`), 'pt');
  assert.equal(langOf(`${D}/bluesky.md`), undefined);
  // A two-letter folder elsewhere in a path is not a language
  assert.equal(langOf('launches/ui/v1.0.0/telegram.md'), undefined);
  assert.equal(langOf('src/content/posts/eng/x.md'), undefined);
});

test('the switch offers each language of a piece once, in order; one language offers none', () => {
  const paths = (...p: string[]) => p.map((path) => ({ path }));
  assert.deepEqual(langsOf(paths('src/content/posts/en/a.md', 'src/content/posts/fr/a.md', 'src/content/posts/de/a.md')), ['en', 'fr', 'de']);
  assert.deepEqual(langsOf(paths(`${D}/newsletter-en.md`, `${D}/newsletter-es.md`)), ['en', 'es']);
  assert.deepEqual(langsOf(paths('src/content/posts/en/a.md')), ['en'], 'a single language: the screens show no switch');
  assert.deepEqual(langsOf(paths(`${D}/bluesky.md`)), []);
  assert.equal(langName('fr'), 'French');
  assert.equal(langName('xx'), 'xx');
});

test('the article piece leads with English and names every language it has', () => {
  const draft = (path: string) => ({ path, kind: 'article' as const, label: path, content: '---\ntitle: "T"\n---\n\nBody.' });
  const [article] = piecesOf([draft('src/content/posts/de/a.md'), draft('src/content/posts/en/a.md'), draft('src/content/posts/fr/a.md')], () => undefined, (c) => c);
  assert.deepEqual(article?.drafts.map((d) => d.path), ['src/content/posts/en/a.md', 'src/content/posts/de/a.md', 'src/content/posts/fr/a.md']);
  assert.match(article?.meta ?? '', /^German, English and French · /);
});

test('“Translate” goes to the brand’s other language', () => {
  assert.equal(translateLabel('es', ['en', 'es']), 'Translate to English');
  assert.equal(translateLabel('en', ['en', 'es']), 'Translate to Spanish');
  assert.equal(translateLabel(undefined, ['en', 'es']), 'Translate EN ↔ ES');
  assert.equal(translateLabel('de', ['de', 'fr']), 'Translate to French');
  assert.equal(translateLabel('en', ['en']), 'Translate', 'a brand in one language has nothing to translate into');
  assert.equal(translateLabel(undefined, []), 'Translate');
});
