import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseBrand } from '../src/index.ts';

test("the personal brand's brand.yml, as it is in yeyo11/launches, is valid", () => {
  const text = readFileSync(new URL('./fixtures/brand.yml', import.meta.url), 'utf8');
  const result = parseBrand(text);
  assert.ok(result.ok, JSON.stringify(!result.ok && result.issues));
  assert.equal(result.value.id, 'personal');
  assert.equal(result.value.handles.reddit, 'https://www.reddit.com/user/josegarridodev/');
  assert.deepEqual(result.value.languages.blog, ['en', 'es']);
  assert.equal(result.value.languages.x, undefined, 'the personal brand does not publish on X');
});

test('a handle is a full https URL', () => {
  const result = parseBrand('id: personal\ndisplayName: Me\ngithub: me\nhandles:\n  x: "@me"\n');
  assert.ok(!result.ok);
  assert.equal(result.issues[0]?.path, 'handles.x');
  assert.equal(result.issues[0]?.line, 5);
});

test('an unknown network is refused', () => {
  const result = parseBrand('id: personal\ndisplayName: Me\ngithub: me\nhandles:\n  myspace: https://myspace.com/me\n');
  assert.ok(!result.ok);
});

test('the blog needs at least one language', () => {
  const result = parseBrand('id: personal\ndisplayName: Me\ngithub: me\nlanguages:\n  blog: []\n');
  assert.ok(!result.ok);
  assert.equal(result.issues[0]?.path, 'languages.blog');
});
