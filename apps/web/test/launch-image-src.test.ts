import assert from 'node:assert/strict';
import { test } from 'node:test';
import { launchImageSrc, MISSING_IMAGE } from '../src/components/editor/images.ts';
import { renderMarkdown } from '../src/components/editor/visual.ts';

/*
 * An article's images on a launch's edit screen (docs/web-app.md): the Markdown links them at the
 * site's paths, which the app does not serve; the page shows each from the launch's own files, which
 * the app serves at /media/<id>, and a clean placeholder for one the launch does not hold.
 */

const DIR = 'articles/sluice-una-cola';
const files = [
  { path: `src/content/posts/en/sluice.md`, kind: 'article' },
  { path: `public/${DIR}/sluice-explain.png`, kind: 'image', url: '/media/41' },
  { path: `public/${DIR}/sluice-doctor.png`, kind: 'image', url: '/media/42' },
  { path: `public/${DIR}/og.png`, kind: 'image', url: '/media/43' },
  { path: `public/launches/other/v1/og.png`, kind: 'image', url: '/media/44' },
  { path: `public/${DIR}/clip.mp4`, kind: 'video', url: '/media/45' },
  { path: `public/${DIR}/no-url.png`, kind: 'image' },
];

test('a root-relative image is the site path of one of the launch’s files, shown from the app', () => {
  const src = launchImageSrc(files);
  assert.equal(src(`/${DIR}/sluice-explain.png`), '/media/41');
  assert.equal(src(` /${DIR}/sluice-doctor.png `), '/media/42');
  assert.equal(src(`/${DIR}/sluice-doctor.png?v=2#top`), '/media/42');
  assert.equal(src('/launches/other/v1/og.png'), '/media/44');
});

test('a page-relative image names a file of the launch’s folder; a name two folders share is not guessed', () => {
  const src = launchImageSrc(files);
  assert.equal(src('sluice-explain.png'), '/media/41');
  assert.equal(src('./sluice-doctor.png'), '/media/42');
  assert.equal(src('og.png'), MISSING_IMAGE);
  assert.equal(src('../sluice-explain.png'), MISSING_IMAGE);
});

test('an image the launch does not hold, or not as an image the app serves, shows the placeholder', () => {
  const src = launchImageSrc(files);
  assert.equal(src(`/${DIR}/sluice-cache-hit.png`), MISSING_IMAGE);
  assert.equal(src(`/${DIR}/clip.mp4`), MISSING_IMAGE);
  assert.equal(src(`/${DIR}/no-url.png`), MISSING_IMAGE);
  assert.equal(src(`//evil.example/${DIR}/sluice-explain.png`), MISSING_IMAGE);
  assert.equal(src('javascript:alert(1)'), MISSING_IMAGE);
  assert.equal(src(''), MISSING_IMAGE);
  assert.equal(launchImageSrc([])(`/${DIR}/sluice-explain.png`), MISSING_IMAGE);
  assert.match(decodeURIComponent(MISSING_IMAGE), /^data:image\/svg\+xml,<svg [^>]*>.*Image not found.*<\/svg>$/);
});

test('a web or inline image is shown as it is', () => {
  const src = launchImageSrc(files);
  assert.equal(src('https://josegarrido.dev/articles/x/a.png'), 'https://josegarrido.dev/articles/x/a.png');
  assert.equal(src('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA');
});

test('the formatted text shows each image where the resolver says, and the Markdown keeps its address', () => {
  const markdown = `Intro\n\n![The explain](/${DIR}/sluice-explain.png)\n\n![Gone](/${DIR}/gone.png)\n\n[a link](/${DIR}/sluice-explain.png)`;
  const html = renderMarkdown(markdown, { imageSrc: launchImageSrc(files) });
  assert.match(html, /<img src="\/media\/41" alt="The explain">/);
  assert.match(html, /<img src="data:image\/svg\+xml,[^"]+" alt="Gone">/);
  // A link is not an image: it keeps the site's path
  assert.match(html, new RegExp(`<a href="/${DIR}/sluice-explain.png">a link</a>`));
  assert.ok(markdown.includes(`(/${DIR}/sluice-explain.png)`));
  // Without a resolver, as before
  assert.match(renderMarkdown(markdown), new RegExp(`<img src="/${DIR}/sluice-explain.png"`));
});

test('what a resolver answers passes the same check: nothing that runs', () => {
  const html = renderMarkdown('![x](a.png)', { imageSrc: () => 'javascript:alert(1)' });
  assert.match(html, /<img src="#" alt="x">/);
});
