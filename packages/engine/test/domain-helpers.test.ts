import assert from 'node:assert/strict';
import { test } from 'node:test';
import { articleUrl, ContentPack } from '@shipcast/schema';
import { parseDiscussionDraft, parseInstagramDraft } from '../src/index.ts';

// Characterisation: what the helpers duplicated across engine, runtime and web do today, pinned
// before they move to the domain package, so the move can be checked against them

test('a draft’s own `---` line splits a title or a comment from the text: not front matter', () => {
  assert.deepEqual(parseInstagramDraft('Comment: What for?\n\n---\n\nThe caption\n---\nmore'), { caption: 'The caption\n---\nmore', comment: 'What for?' });
  assert.deepEqual(parseInstagramDraft('Just a caption'), { caption: 'Just a caption', comment: undefined });
  assert.deepEqual(parseDiscussionDraft('Title: T\n\n---\n\nBody', { title: 'F', body: 'FB' }), { title: 'T', body: 'Body' });
  assert.deepEqual(parseDiscussionDraft('---\n', { title: 'F', body: 'FB' }), { title: 'F', body: 'FB' });
});

test('articleUrl is the version’s address, or nothing for a language the pack lacks', () => {
  const pack = { article: { en: { slug: 'claudio-launch' } } } as unknown as ContentPack;
  assert.equal(articleUrl(pack, 'https://josegarrido.dev', 'en'), 'https://josegarrido.dev/en/claudio-launch/');
  assert.equal(articleUrl(pack, 'https://josegarrido.dev', 'es'), undefined);
  assert.equal(articleUrl({} as ContentPack, 'https://josegarrido.dev', 'en'), undefined);
});
