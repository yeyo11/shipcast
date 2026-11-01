import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyProposal, diffSummary, readableDiff, sentenceContext, splitProposals, tokens, wordDiff } from '../src/components/assistant/diff.ts';

const rebuild = (parts: ReturnType<typeof wordDiff>, side: 'before' | 'after') => parts.filter((p) => p.type === 'equal' || p.type === (side === 'before' ? 'delete' : 'insert')).map((p) => p.text).join('');

test('tokens keep words with their apostrophes and hyphens, whitespace runs and marks', () => {
  assert.deepEqual(tokens("It's a well-known  tool."), ["It's", ' ', 'a', ' ', 'well-known', '  ', 'tool', '.']);
  assert.deepEqual(tokens('Añadí más'), ['Añadí', ' ', 'más']);
});

test('a word-level diff rebuilds both texts exactly', () => {
  const before = 'Shipcast reads the code and writes a pack.\n\nIt publishes.';
  const after = 'Shipcast reads your code, then writes a pack.\n\nIt publishes on approval.';
  const parts = wordDiff(before, after);
  assert.equal(rebuild(parts, 'before'), before);
  assert.equal(rebuild(parts, 'after'), after);
});

test('a run of changes reads as one deletion then one insertion', () => {
  assert.deepEqual(wordDiff('the old way works', 'a new path works'), [
    { type: 'delete', text: 'the old way' },
    { type: 'insert', text: 'a new path' },
    { type: 'equal', text: ' works' },
  ]);
});

test('no change, all new and all gone', () => {
  assert.deepEqual(wordDiff('same', 'same'), [{ type: 'equal', text: 'same' }]);
  assert.deepEqual(wordDiff('', 'brand new'), [{ type: 'insert', text: 'brand new' }]);
  assert.deepEqual(wordDiff('gone now', ''), [{ type: 'delete', text: 'gone now' }]);
});

test('the summary counts words, not spaces or marks', () => {
  assert.deepEqual(diffSummary(wordDiff('one two.', 'one three four.')), { inserted: 2, deleted: 1 });
});

test('a long text still diffs, without a table too large for a browser', () => {
  const before = Array.from({ length: 3000 }, (_, i) => `w${i}`).join(' ');
  const after = Array.from({ length: 3000 }, (_, i) => `v${i}`).join(' ');
  const parts = wordDiff(before, after);
  assert.equal(rebuild(parts, 'before'), before);
  assert.equal(rebuild(parts, 'after'), after);
});

test('a chat answer is split into prose and proposals, an open block marked incomplete', () => {
  assert.deepEqual(splitProposals('Here:\n```proposal\nNew text.\n```\nShorter now.'), [
    { type: 'prose', text: 'Here:' },
    { type: 'proposal', text: 'New text.', complete: true },
    { type: 'prose', text: 'Shorter now.' },
  ]);
  assert.deepEqual(splitProposals('Working:\n```proposal\nNew te'), [
    { type: 'prose', text: 'Working:' },
    { type: 'proposal', text: 'New te', complete: false },
  ]);
  assert.deepEqual(splitProposals('Just an answer.'), [{ type: 'prose', text: 'Just an answer.' }]);
});

test('accepting replaces the selected range, or the whole text without one', () => {
  assert.equal(applyProposal('Hello old world', { start: 6, end: 9 }, 'new'), 'Hello new world');
  assert.equal(applyProposal('Hello', undefined, 'Bye'), 'Bye');
  assert.equal(applyProposal('Hello', { start: 2, end: 2 }, 'Bye'), 'Bye');
});

test('the context of a selection is the rest of its sentence on each side', () => {
  const doc = 'For two years my notes lived apart. They were never where the code was, so they went stale.\n\nNow they live in docs/.';
  const start = doc.indexOf('so they');
  const end = doc.indexOf('stale.') + 'stale.'.length;
  assert.deepEqual(sentenceContext(doc, { start, end }), { before: 'They were never where the code was, ', after: '' });
  const word = doc.indexOf('never');
  assert.deepEqual(sentenceContext(doc, { start: word, end: word + 5 }), { before: 'They were ', after: ' where the code was, so they went stale.' });
  const now = doc.lastIndexOf('live');
  assert.deepEqual(sentenceContext(doc, { start: now, end: now + 4 }), { before: 'Now they ', after: ' in docs/.' });
});

test('a long context is cut at a word and marked', () => {
  const doc = `${'word '.repeat(60)}target ${'more '.repeat(60)}end.`;
  const start = doc.indexOf('target');
  const { before, after } = sentenceContext(doc, { start, end: start + 6 }, 20);
  assert.ok(before.startsWith('…') && before.length <= 22, before);
  assert.ok(after.endsWith('…') && after.length <= 22, after);
});

test('a readable diff joins changes a few words apart into one deletion and one insertion', () => {
  const before = 'so they went stale the week I wrote them.';
  const after = 'so they were out of date by the time I needed them.';
  const parts = readableDiff(wordDiff(before, after));
  assert.equal(rebuild(parts, 'before'), before);
  assert.equal(rebuild(parts, 'after'), after);
  assert.deepEqual(
    parts.map((p) => p.type),
    ['equal', 'delete', 'insert', 'equal'],
  );
  assert.equal(parts[0]!.text, 'so they ');
  assert.equal(parts.at(-1)!.text, ' them.');
});

test('a readable diff keeps changes far apart as they are', () => {
  const before = 'One small change here, and then a long stretch of the same words follows before another change.';
  const after = 'One tiny change here, and then a long stretch of the same words follows before another edit.';
  const parts = readableDiff(wordDiff(before, after));
  assert.deepEqual(
    parts.map((p) => p.type),
    ['equal', 'delete', 'insert', 'equal', 'delete', 'insert', 'equal'],
  );
});
