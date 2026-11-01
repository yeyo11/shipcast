import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { EDITOR_PROFILES } from '@shipcast/schema/channels';
import { escapeText, roundTrip } from '../src/components/editor/extensions.ts';
import { applyTool, articleDestinations, insertImage, insertLink, toolsFor } from '../src/components/editor/toolbar.ts';
import { markedDiff, MARKS, rangeOf, renderMarkdown, splitRuns } from '../src/components/editor/visual.ts';

/*
 * The rich editor without a browser (docs/decisions/rich-editor.md): the Markdown string is the
 * model, so a round trip through the Visual mode's document must give it back as written; the
 * toolbar follows the profile; the assistant's selection and diff work on the string.
 */

const blog = EDITOR_PROFILES.blog!;
const FIXTURES = join(import.meta.dirname, 'fixtures', 'articles');

test('real articles go through the Visual mode and come back as written: tables, images, code, links with queries', () => {
  const files = readdirSync(FIXTURES).filter((f) => f.endsWith('.md'));
  assert.ok(files.length >= 3);
  for (const file of files) {
    const markdown = readFileSync(join(FIXTURES, file), 'utf8');
    assert.equal(roundTrip(markdown, blog), markdown, file);
  }
});

const SYNTHETIC = `## A heading with \`code\`

Some *italics*, **bold**, ~~gone~~ and a [link](https://example.dev/a?utm_source=x&b=2#frag) in it. Q&A, x86_64, ~40% and 5 * 3.

1. one
2. two
   - nested
   - list

- [ ] to do
- [x] done

> A quote
> on two lines

\`\`\`ts
const a = 1 < 2 && b_c;
\`\`\`

![An image](/articles/slug/shot.png)

---

| A | B |
| :--- | ---: |
| 1 | \`x \\| y\` |
`;

test('every block the article takes survives the round trip', () => {
  assert.equal(roundTrip(SYNTHETIC, blog), SYNTHETIC);
});

test('the normalisations a round trip makes, and only these', () => {
  // Underscore italics are written with asterisks
  assert.equal(roundTrip('An _idea_.', blog), 'An *idea*.');
  // A table loses its padding
  assert.equal(roundTrip('| a   | b |\n| --- | --- |\n| 1   | 2 |', blog), '| a | b |\n| --- | --- |\n| 1 | 2 |');
  // A literal character that would read as syntax is escaped, and only then
  assert.equal(escapeText('x86_64, _x, a*b, 5 * 3, Q&A, &amp;, <div>, a < b, ~1 and ~2'), 'x86_64, \\_x, a\\*b, 5 * 3, Q&A, \\&amp;, \\<div>, a < b, \\~1 and ~2');
});

test('a light profile keeps its own syntax through the Visual mode: Telegram’s underline and spoiler', () => {
  const telegram = EDITOR_PROFILES.telegram!;
  const text = '**claudio 1.0** is <u>out</u>, with a ||secret||. [Read it](https://josegarrido.dev/en/claudio/?ref=telegram)\n\n> quoted';
  assert.equal(roundTrip(text, telegram), text);
  // Syntax the profile lacks is not in its document: a heading stays its words
  assert.equal(roundTrip('## Title', telegram), 'Title');
  // A heading deeper than Discord shows is brought up to the deepest it does
  assert.equal(roundTrip('#### Deep\n\n### Fine', EDITOR_PROFILES.discord!), '### Deep\n\n### Fine');
});

test('the toolbar is the profile: the article has every button, Discord no table, Bluesky none', () => {
  const ids = (channel: keyof typeof EDITOR_PROFILES) => toolsFor(EDITOR_PROFILES[channel]!).map((t) => t.id);
  assert.deepEqual(ids('blog'), ['heading2', 'heading3', 'bold', 'italic', 'strike', 'code', 'link', 'quote', 'bulletList', 'orderedList', 'taskList', 'codeBlock', 'table', 'image']);
  assert.ok(!ids('discord').includes('table'));
  assert.ok(ids('discord').includes('heading3'));
  assert.deepEqual(ids('telegram'), ['bold', 'italic', 'underline', 'strike', 'code', 'spoiler', 'link', 'quote']);
  assert.deepEqual(ids('bluesky'), []);
});

test('in the Markdown mode a button writes its syntax, and a second press takes it off', () => {
  const bold = applyTool('make it bold now', { start: 8, end: 12 }, 'bold');
  assert.deepEqual(bold, { text: 'make it **bold** now', selection: { start: 10, end: 14 } });
  assert.deepEqual(applyTool(bold.text, bold.selection, 'bold'), { text: 'make it bold now', selection: { start: 8, end: 12 } });
  assert.equal(applyTool('one\ntwo', { start: 0, end: 7 }, 'bulletList').text, '- one\n- two');
  assert.equal(applyTool('- one\n- two', { start: 0, end: 11 }, 'bulletList').text, 'one\ntwo');
  assert.equal(applyTool('one\ntwo', { start: 0, end: 7 }, 'orderedList').text, '1. one\n2. two');
  assert.equal(applyTool('## Old', { start: 3, end: 3 }, 'heading3').text, '### Old');
  assert.equal(applyTool('a\ncode\nb', { start: 2, end: 6 }, 'codeBlock').text, 'a\n```\ncode\n```\nb');
  assert.equal(applyTool('Text.', { start: 5, end: 5 }, 'table').text, 'Text.\n\n| Column | Column |\n| --- | --- |\n|  |  |');
  assert.equal(insertLink('see the docs', { start: 8, end: 12 }, 'https://x.dev').text, 'see the [docs](https://x.dev)');
  assert.equal(insertImage('Before.\nAfter.', { start: 7, end: 7 }, { alt: 'A [cat]', src: '/articles/a/cat.png' }).text, 'Before.\n\n![A cat](/articles/a/cat.png)\n\nAfter.');
});

test('a selection made in the Visual mode is found in the Markdown, the occurrence nearest where it was', () => {
  const markdown = 'It is **fast**. Later: it is **fast** again.';
  assert.deepEqual(rangeOf(markdown, { markdown: '**fast**', plain: 'fast' }, 0.9), { start: 29, end: 37 });
  assert.deepEqual(rangeOf(markdown, { markdown: '**fast**', plain: 'fast' }, 0), { start: 6, end: 14 });
  // A slice whose Markdown is not in the text is found by its words
  assert.deepEqual(rangeOf('A [link](https://x.dev) here', { markdown: 'link here', plain: 'link' }, 0), { start: 3, end: 7 });
  assert.equal(rangeOf('nothing', { markdown: 'else', plain: 'else' }, 0), undefined);
});

test('a proposal is shown formatted: its runs marked through the Markdown, block syntax left outside', () => {
  const marked = markedDiff('## Old title\n\nIt is fast.', '## New title\n\nIt is **very** fast.');
  assert.ok(marked.startsWith(`## ${MARKS.delOpen}Old${MARKS.delClose}`) || marked.startsWith('## '), marked);
  const html = renderMarkdown(marked);
  assert.match(html, /<h2>/);
  assert.match(html, /<strong>/);
  assert.deepEqual(splitRuns(`a${MARKS.delOpen}b${MARKS.delClose}c${MARKS.insOpen}d`, 'equal'), {
    runs: [
      { text: 'a', change: 'equal' },
      { text: 'b', change: 'delete' },
      { text: 'c', change: 'equal' },
      { text: 'd', change: 'insert' },
    ],
    open: 'insert',
  });
  // Nothing in the text runs: raw HTML is shown as text, a script link goes nowhere
  assert.doesNotMatch(renderMarkdown('<script>x</script> [a](javascript:alert)'), /<script>|href="javascript/);
});

test('Write’s status line says where the article goes as written, from the channel definitions', () => {
  assert.equal(articleDestinations(), 'Blog, dev.to and Hashnode; the other channels are written from it');
});
