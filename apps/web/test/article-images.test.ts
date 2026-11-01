import assert from 'node:assert/strict';
import { test } from 'node:test';
import { articleFolder, describeImage, imagesWithoutAlt, linkedImages } from '../src/components/editor/images.ts';
import { InvalidInput } from '../src/server/input.ts';
import { articleRequest } from '../src/server/requests.ts';

/*
 * Images on Write (docs/decisions/rich-editor.md): the request that prepares an article refuses an
 * image without alt text and takes the uploads its body links; the editor asks for each missing alt.
 */

const SHA = `0123456789abcdef${'0'.repeat(48)}`;
const NAME = '0123456789abcdef.png';

test('preparing an article refuses an image without alt text, with the reason, before any work', () => {
  assert.throws(() => articleRequest({ title: 'T', markdown: `![](/articles/t/${NAME})`, lang: 'en' }), (e: unknown) => e instanceof InvalidInput && /has no alt text/.test(e.message));
  assert.throws(() => articleRequest({ title: 'T', markdown: `![${'x'.repeat(141)}](/articles/t/${NAME})`, lang: 'en' }), /at most 140/);
});

test('the uploads an article links come with it, checked: a sha256 and the name the upload gave', () => {
  const ok = articleRequest({ title: 'T', markdown: `![Shot](/articles/t/${NAME})`, lang: 'en', images: [{ sha256: SHA, name: NAME }] });
  assert.deepEqual(ok.input.images, [{ sha256: SHA, name: NAME }]);
  assert.equal(articleRequest({ title: 'T', markdown: 'No images', lang: 'en' }).input.images, undefined);
  assert.throws(() => articleRequest({ title: 'T', markdown: 'x', lang: 'en', images: [{ sha256: 'nope', name: NAME }] }), /sha256 the upload answered/);
  assert.throws(() => articleRequest({ title: 'T', markdown: 'x', lang: 'en', images: [{ sha256: SHA, name: 'ffffffffffffffff.png' }] }), /the upload's name/);
  assert.throws(() => articleRequest({ title: 'T', markdown: 'x', lang: 'en', images: [{ sha256: SHA, name: '../../etc.png' }] }), /the upload's name/);
});

test('the editor finds each image without alt text and describes it in place', () => {
  const text = `Intro.\n\n![](/articles/t/${NAME})\n\n![Kept](/k.png)\n\n![ ](/b.png)`;
  const missing = imagesWithoutAlt(text);
  assert.deepEqual(missing.map((m) => m.src), [`/articles/t/${NAME}`, '/b.png']);
  assert.equal(describeImage(text, missing[0]!.at, 'The [setup]\napplied'), `Intro.\n\n![The setup applied](/articles/t/${NAME})\n\n![Kept](/k.png)\n\n![ ](/b.png)`);
  assert.equal(describeImage(text, 3, 'not an image'), text);
});

test('an image is linked at the folder of the title as it is written; the article takes only the uploads it links', () => {
  assert.equal(articleFolder('Montó REA: ¿qué acierta?'), '/articles/monto-rea-que-acierta');
  assert.equal(articleFolder(''), '/articles/article');
  const kept = [{ sha256: SHA, name: NAME }, { sha256: 'f'.repeat(64), name: 'ffffffffffffffff.png' }];
  assert.deepEqual(linkedImages(`![Shot](/articles/old/${NAME})`, kept), [kept[0]]);
});
