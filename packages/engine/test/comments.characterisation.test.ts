import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PostGone, type Comment } from '@shipcast/connectors';
import { Brand } from '@shipcast/schema';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import { runComments, writeCommentSettings, type ReplyDeps } from '../src/index.ts';
import { aPublishedLaunch, FakeConnectors, memoryRegistry, mockRunner, textParts } from '../src/testing/index.ts';

/*
 * Characterisation: one run of the comment assistant over several posts and channels, as it is
 * today, before CommentService and the CommentFeed capability replace the per-post reads
 * (docs/plans/performance-refactor.md, phase 3): what is read, what is drafted, what is sent, what
 * the run logs and what a second run does.
 */

const brand = Brand.parse({ id: 'personal', displayName: 'Me', site: 'https://josegarrido.dev', github: 'yeyo11' });

const comment = (externalId: string, text: string): Comment => ({ externalId, author: { handle: '@ana@fosstodon.org' }, text, createdAt: '2026-11-03T09:00:00.000Z', own: false });

const answer = (value: unknown) => ({ stream: convertArrayToReadableStream(textParts(JSON.stringify(value))) });

test('one run over several posts: read, drafted, sent where auto, logged; a second run adds nothing', async () => {
  const registry = await memoryRegistry();
  const { posts } = await aPublishedLaunch(registry, [
    { channel: 'mastodon', externalId: 'm1' },
    { channel: 'bluesky', externalId: 'b1' },
    { channel: 'threads', externalId: 't1' },
    { channel: 'devto', externalId: '42' },
    { channel: 'instagram', externalId: 'ig1' },
    { channel: 'githubDiscussions', externalId: 'D_1' },
    { channel: 'telegram', externalId: '@c:1' },
  ]);
  const instagram = posts[4]!;
  await writeCommentSettings(registry, { replies: { mastodon: 'auto', bluesky: 'approval', threads: 'off', devto: 'auto' } });

  const fake = new FakeConnectors();
  fake.threads = {
    'mastodon:m1': [comment('101', 'Does it run on Windows?'), comment('102', 'cheap pills here')],
    'bluesky:b1': [comment('201', 'Nice!')],
    'threads:t1': [comment('301', 'Never read: Threads is off')],
    'devto:42': [comment('401', 'How does it work?')],
  };
  fake.fail('instagram', 'comments', new PostGone('Instagram', 'the media ig1 no longer exists', 404));
  fake.unconnected.add('githubDiscussions');

  const model = new MockLanguageModelV4({
    doStream: async (options) =>
      JSON.stringify(options.prompt).includes('cheap pills')
        ? answer({ classification: 'spam', language: 'en', dismiss: true, reply: '', reason: 'An ad' })
        : answer({ classification: 'question', language: 'en', dismiss: false, reply: 'Thanks for asking.', reason: 'A question' }),
  });
  const deps: ReplyDeps = {
    registry,
    connectors: fake.commentConnectors(),
    brand,
    aiRunner: mockRunner(model),
    context: async () => ({ postText: {} }),
  };
  const lines: string[] = [];

  const run = await runComments(deps, { log: (line) => lines.push(line) });
  assert.equal(run.posts, 3, 'Mastodon, Bluesky and dev.to; the gone, the unconnected and the off ones are not counted');
  assert.equal(run.found, 4);
  assert.equal(run.added.length, 4);
  assert.deepEqual(run.gone.map((p) => [p.id, p.status]), [[instagram.id, 'deleted']]);
  assert.deepEqual(run.problems, ['GitHub Discussions: no connected account to read comments with']);
  assert.equal(run.drafted.length, 4, 'the spam counts as drafted, with no draft');
  assert.equal(run.toDismiss, 1);
  assert.deepEqual(run.sent.map((c) => [c.channel, c.externalId, c.status]), [['mastodon', '101', 'sent']], 'auto on Mastodon only: dev.to’s auto is stored as approval');
  assert.deepEqual(fake.callsOf('mastodon', 'reply').map((c) => c.input), [
    { target: { postExternalId: 'm1', commentExternalId: '101', authorHandle: '@ana@fosstodon.org' }, text: 'Thanks for asking.', key: 'shipcast-reply-mastodon-101' },
  ]);
  const states = Object.fromEntries((await registry.comments.comments({ limit: 50 })).map((c) => [`${c.channel}:${c.externalId}`, c.status]));
  assert.deepEqual(states, { 'mastodon:101': 'sent', 'mastodon:102': 'draft-ready', 'bluesky:201': 'draft-ready', 'devto:401': 'draft-ready' });
  assert.deepEqual(fake.callsOf('threads'), [], 'a channel set to off is never asked');
  assert.deepEqual(fake.callsOf('telegram'), [], 'nor one without comments');
  assert.deepEqual(lines, [
    'Read 3 posts: 4 comments, 4 new',
    `Instagram post ${instagram.id} no longer exists on the network: marked deleted, and not read again`,
    'GitHub Discussions: no connected account to read comments with',
  ]);

  const again = await runComments(deps);
  assert.deepEqual([again.posts, again.found, again.added.length, again.drafted.length, again.sent.length], [3, 4, 0, 0, 0]);
  assert.equal(fake.callsOf('instagram').length, 1, 'a post marked deleted is not read again');
  assert.equal(model.doStreamCalls.length, 4, 'no AI call for what is known');
});
