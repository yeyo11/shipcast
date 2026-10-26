import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyProposal, diffSummary, splitProposals, tokens, wordDiff } from '../src/components/assistant/diff.ts';

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
