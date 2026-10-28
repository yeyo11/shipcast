import assert from 'node:assert/strict';
import { test } from 'node:test';
import { draftPrefill } from '../src/server/pieces.ts';

// Characterisation: the edge cases of the front matter split and the draft body the prefill shares
// with the engine, pinned before both move to the domain package

const blog = (content: string) => draftPrefill([{ path: 'src/content/posts/en/x.md', content }], { channel: 'blog', kind: 'article:en' });
const channel = (content: string) => draftPrefill([{ path: 'launches/x/v1/mastodon.md', content }], { channel: 'mastodon', kind: 'post' });

test('the front matter is split at the first closing line, with or without a newline after it', () => {
  assert.deepEqual(blog('---\ntitle: A\n---\nbody\n'), { text: 'body', title: 'A' });
  assert.deepEqual(blog('---\ntitle: A\n---body'), { text: 'body', title: 'A' });
  assert.deepEqual(blog("---\ntitle: 'A'\n---\nx\n---\ny\n"), { text: 'x\n---\ny', title: 'A' });
  assert.deepEqual(blog('---\n\n---\nbody'), { text: 'body', title: '' });
});

test('what is not front matter (none, empty, CRLF, a leading space) is a draft read for its body', () => {
  assert.deepEqual(blog('---\n---\nbody'), { text: '---\n---\nbody', title: '' });
  assert.deepEqual(blog('---\r\ntitle: A\r\n---\r\nbody'), { text: '---\r\ntitle: A\r\n---\r\nbody', title: '' });
  assert.deepEqual(blog(' ---\ntitle: A\n---\nbody'), { text: '---\ntitle: A\n---\nbody', title: '' });
  assert.deepEqual(channel('# Mastodon\n\n> **Approval:** a\n\nThe post\n'), { text: 'The post', title: '' });
  assert.deepEqual(channel('No note at all\n'), { text: 'No note at all', title: '' });
});
