import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseFrontMatter, splitFrontMatter } from '../src/index.ts';

// The cases the copies in engine (edit, publish) and web (the edit prefill) agreed on before they
// became this one

test('the front matter ends at the first closing line, with or without a newline after it', () => {
  assert.deepEqual(splitFrontMatter('---\ntitle: A\n---\nbody\n'), { front: 'title: A', body: 'body\n' });
  assert.deepEqual(splitFrontMatter('---\ntitle: A\n---body'), { front: 'title: A', body: 'body' });
  assert.deepEqual(splitFrontMatter('---\na: 1\n---\nx\n---\ny'), { front: 'a: 1', body: 'x\n---\ny' });
  assert.deepEqual(splitFrontMatter('---\n\n---\nbody'), { front: '', body: 'body' });
  assert.deepEqual(splitFrontMatter('---\na: 1\n---'), { front: 'a: 1', body: '' });
});

test('no front matter: none at all, an empty block, CRLF line ends or a leading space', () => {
  assert.equal(splitFrontMatter('just text'), undefined);
  assert.equal(splitFrontMatter(''), undefined);
  assert.equal(splitFrontMatter('---\n---\nbody'), undefined);
  assert.equal(splitFrontMatter('---\r\ntitle: A\r\n---\r\nbody'), undefined);
  assert.equal(splitFrontMatter(' ---\ntitle: A\n---\nbody'), undefined);
});

test('parsed, the front matter is its YAML and the body is trimmed; without one the text is the body as it is', () => {
  assert.deepEqual(parseFrontMatter('---\ntitle: "A"\ntags: [x, y]\n---\n\n Body \n'), { data: { title: 'A', tags: ['x', 'y'] }, body: 'Body' });
  assert.deepEqual(parseFrontMatter('---\n\n---\nbody'), { data: {}, body: 'body' });
  assert.deepEqual(parseFrontMatter('  no front matter \n'), { data: {}, body: '  no front matter \n' });
});
