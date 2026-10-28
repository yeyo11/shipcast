import assert from 'node:assert/strict';
import { test } from 'node:test';
import { articleLink, articleUrl, type ContentPack } from '../src/index.ts';

const pack = { article: { en: { slug: 'claudio-launch' }, es: { slug: 'claudio-lanzamiento' } } } as unknown as ContentPack;
const english = { article: { en: { slug: 'claudio-launch' } } } as unknown as ContentPack;
const site = 'https://josegarrido.dev';

test('articleUrl is the version’s address, or nothing for a language the pack lacks', () => {
  assert.equal(articleUrl(english, 'https://josegarrido.dev', 'en'), 'https://josegarrido.dev/en/claudio-launch/');
  assert.equal(articleUrl(english, 'https://josegarrido.dev', 'es'), undefined);
  assert.equal(articleUrl({} as ContentPack, 'https://josegarrido.dev', 'en'), undefined);
});

// The wrappers engine's drafts and publishing each wrote around articleUrl, now one
test('articleLink is the first language the pack has an article in, else the site', () => {
  assert.equal(articleLink(pack, site, 'es', 'en'), `${site}/es/claudio-lanzamiento/`);
  assert.equal(articleLink(english, site, 'es', 'en'), `${site}/en/claudio-launch/`);
  assert.equal(articleLink(english, site, 'es'), site);
  assert.equal(articleLink({} as ContentPack, site, 'en', 'es'), site);
  assert.equal(articleLink(pack, site), site);
});
