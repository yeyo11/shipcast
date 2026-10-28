import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDiscussionDraft, parseInstagramDraft } from '../src/index.ts';

// A draft's own `---` separator, pinned when the front matter split moved to the domain package:
// the two look alike and are not the same thing

test('a draft’s own `---` line splits a title or a comment from the text: not front matter', () => {
  assert.deepEqual(parseInstagramDraft('Comment: What for?\n\n---\n\nThe caption\n---\nmore'), { caption: 'The caption\n---\nmore', comment: 'What for?' });
  assert.deepEqual(parseInstagramDraft('Just a caption'), { caption: 'Just a caption', comment: undefined });
  assert.deepEqual(parseDiscussionDraft('Title: T\n\n---\n\nBody', { title: 'F', body: 'FB' }), { title: 'T', body: 'Body' });
  assert.deepEqual(parseDiscussionDraft('---\n', { title: 'F', body: 'FB' }), { title: 'F', body: 'FB' });
});
