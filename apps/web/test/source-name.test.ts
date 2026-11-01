import assert from 'node:assert/strict';
import { test } from 'node:test';
import { siteHost, sourceName } from '../src/server/source-name.ts';

test('a source of numbers is named by its service and the site, never by its raw label', () => {
  assert.equal(sourceName('bingWebmaster', 'https://josegarrido.dev'), 'Bing Webmaster · josegarrido.dev');
  assert.equal(sourceName('cloudflare', 'https://www.josegarrido.dev/'), 'Cloudflare · josegarrido.dev');
  assert.equal(sourceName('searchConsole', null), 'Search Console');
  assert.equal(sourceName('bluesky', 'https://josegarrido.dev'), null, 'an account with an audience keeps its own label');
  assert.equal(siteHost('not a url at all'), null);
});
