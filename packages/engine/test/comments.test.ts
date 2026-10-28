import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConnectorError, PostGone, type Comment, type ReplyTarget } from '@shipcast/connectors';
import { Brand } from '@shipcast/schema';
import { MockLanguageModelV4 } from 'ai/test';
import { CommentRefused, dismissComment, draftReply, editReplyDraft, fetchComments, LOCKED_REPLY_RULES, readCommentSettings, runComments, sendReply, writeCommentSettings, type CommentConnectors, type Repositories, type ReplyContext, type ReplyDeps } from '../src/index.ts';
import { SdkProvider } from '../src/legacy-ai.ts';
import { memoryRegistry } from '../src/testing.ts';

type GenerateResult = Extract<Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>, { content: unknown }>;

const brand = Brand.parse({ id: 'personal', displayName: 'Me', site: 'https://josegarrido.dev', github: 'yeyo11' });

function answer(value: unknown): GenerateResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    finishReason: { unified: 'stop', raw: undefined },
    usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } },
    warnings: [],
  };
}

const comment = (id: string, text: string, extra: Partial<Comment> = {}): Comment => ({
  externalId: id,
  author: { handle: '@ana@fosstodon.org', displayName: 'Ana' },
  text,
  createdAt: `2026-10-2${id.length}T10:00:00.000Z`,
  own: false,
  ...extra,
});

interface World {
  registry: Repositories;
  launchId: number;
  postId: number;
  /** What the network has under the post; tests change it between runs */
  thread: Comment[];
  sent: Array<{ target: ReplyTarget; text: string; key?: string }>;
  connectors: (channel: string, accountId: number | null) => Promise<CommentConnectors>;
}

async function world(channel: 'mastodon' | 'devto' = 'mastodon'): Promise<World> {
  const registry = await memoryRegistry();
  const { launch } = await registry.launches.claim({ repo: 'yeyo11/claudio', ref: 'v1.0.0', trigger: 'release', kind: 'launch', brand: 'personal' });
  const { post } = await registry.posts.recordPost({ launchId: launch.id, channel, externalId: '100', url: 'https://mastodon.social/@me/100' });
  const w: World = {
    registry,
    launchId: launch.id,
    postId: post.id,
    thread: [],
    sent: [],
    connectors: async () => ({
      reader: { comments: async (id) => (id === '100' ? w.thread : []) },
      ...(channel === 'mastodon' && {
        replier: {
          reply: async (target, text, options) => {
            if (text.includes('fail')) throw new ConnectorError('Mastodon', 'reply: 422 Validation failed', 422);
            w.sent.push({ target, text, ...(options?.key && { key: options.key }) });
            return { externalId: `r${w.sent.length}`, url: `https://mastodon.social/@me/r${w.sent.length}` };
          },
        },
      }),
    }),
  };
  return w;
}

const context: ReplyContext = {
  analysis: { summary: 'Claude Code as a service', implemented: ['REST API'], planned: ['Windows support'], documentedOnly: [], limitations: [] },
  postText: { mastodon: 'claudio is out' },
  cwd: '/workspace',
};

function replyDeps(w: World, model: MockLanguageModelV4): ReplyDeps & { contexts: number } {
  const deps = {
    registry: w.registry,
    connectors: w.connectors,
    brand,
    contexts: 0,
    setup: async () => ({ provider: new SdkProvider({ id: 'test', model: () => model }), prompts: {} }),
    context: async () => {
      deps.contexts++;
      return context;
    },
  };
  return deps;
}

const reply = (text: string, extra: Record<string, unknown> = {}) => answer({ classification: 'question', language: 'en', dismiss: false, reply: text, reason: 'They asked about Windows', ...extra });

test('reading the comments twice adds nothing the second time, and the owner’s reply marks its comment answered', async () => {
  const w = await world();
  w.thread = [comment('101', 'Does it run on Windows?')];
  const first = await fetchComments(w);
  assert.equal(first.posts, 1);
  assert.equal(first.added.length, 1);
  assert.equal(first.added[0]!.status, 'new');

  const again = await fetchComments(w);
  assert.equal(again.found, 1);
  assert.equal(again.added.length, 0, 'a known comment is not added again');
  assert.equal((await w.registry.comments.comments()).length, 1);

  // The owner answered on Mastodon by hand: their reply is kept for the thread, the comment is done
  w.thread = [...w.thread, comment('102', 'Not yet', { own: true, inReplyTo: '101', url: 'https://mastodon.social/@me/102' })];
  const third = await fetchComments(w);
  assert.equal(third.answeredByHand, 1);
  const [own, answered] = [await w.registry.comments.commentByExternalId('mastodon', '102'), await w.registry.comments.commentByExternalId('mastodon', '101')];
  assert.equal(own?.own, true);
  assert.equal(own?.status, 'dismissed');
  assert.equal(answered?.status, 'sent');
  assert.equal(answered?.sentExternalId, '102');
  assert.equal((await fetchComments(w)).answeredByHand, 0, 'idempotent once marked');
});

test('only the last 30 days of posts are read, and a channel set to off is not read at all', async () => {
  const w = await world();
  w.thread = [comment('101', 'Hi')];
  const later = { ...w, now: () => new Date(Date.now() + 40 * 86_400_000) };
  assert.equal((await fetchComments(later)).posts, 0);
  await writeCommentSettings(w.registry, { replies: { mastodon: 'off' } });
  assert.equal((await fetchComments(w)).posts, 0);
});

test('a network that fails is reported and the others are read', async () => {
  const w = await world();
  const broken = { ...w, connectors: async () => ({ reader: { comments: async () => Promise.reject(new ConnectorError('Mastodon', 'read the replies: 503', 503)) } }) };
  const result = await fetchComments(broken);
  assert.equal(result.posts, 0);
  assert.match(result.problems[0]!, /Mastodon post \d+: Mastodon: read the replies: 503/);
});

test('a post the network says is gone is marked deleted, not reported, and never read again', async () => {
  const w = await world();
  let reads = 0;
  const gone = { ...w, connectors: async () => ({ reader: { comments: async () => (reads++, Promise.reject(new PostGone('Mastodon', 'the status 100 no longer exists', 404))) } }) };
  const first = await fetchComments(gone);
  assert.deepEqual(first.gone.map((p) => [p.id, p.status]), [[w.postId, 'deleted']]);
  assert.deepEqual(first.problems, []);
  assert.equal((await w.registry.posts.post(w.postId))?.status, 'deleted');
  const second = await fetchComments(gone);
  assert.equal(reads, 1, 'a deleted post is not read again');
  assert.deepEqual(second.gone, []);
});

test('a reply is drafted through the AI provider with the locked rules last, grounded in the analysis and the thread', async () => {
  const w = await world();
  w.thread = [comment('101', 'Is there a Windows build?'), comment('1022', 'Same question', { inReplyTo: '101' })];
  await fetchComments(w);
  const model = new MockLanguageModelV4({ doGenerate: async () => reply('Not yet: Windows support is planned, the REST API works today.') });
  const target = (await w.registry.comments.commentByExternalId('mastodon', '1022'))!;
  const drafted = await draftReply(target.id, replyDeps(w, model));
  assert.equal(drafted.status, 'draft-ready');
  assert.equal(drafted.draft, 'Not yet: Windows support is planned, the REST API works today.');
  assert.equal(drafted.classification, 'question');
  assert.equal(drafted.note, 'They asked about Windows');

  const call = model.doGenerateCalls[0]!;
  const system = call.prompt.find((m) => m.role === 'system');
  assert.ok(system?.role === 'system');
  for (const rule of LOCKED_REPLY_RULES) assert.ok(system.content.includes(rule), rule);
  assert.ok(system.content.trimEnd().endsWith(LOCKED_REPLY_RULES.at(-1)!), 'the locked rules are the last word');
  const user = JSON.stringify(call.prompt.filter((m) => m.role === 'user'));
  for (const piece of ['Windows support', 'REST API', 'claudio is out', '> Is there a Windows build?', '> Same question']) assert.ok(user.includes(piece), piece);
  assert.equal(call.responseFormat?.type, 'json');
  assert.equal((call.tools ?? []).length, 0, 'with no checkout on this machine, no tools');
});

test('spam is classified and suggested for dismissal: no draft, and auto mode never sends it', async () => {
  const w = await world();
  await writeCommentSettings(w.registry, { replies: { mastodon: 'auto' } });
  w.thread = [comment('101', 'Buy followers at spam.example')];
  const model = new MockLanguageModelV4({ doGenerate: async () => answer({ classification: 'spam', language: 'en', dismiss: true, reply: 'Thanks!', reason: 'An ad for followers' }) });
  const result = await runComments(replyDeps(w, model));
  assert.equal(result.toDismiss, 1);
  assert.equal(result.sent.length, 0);
  assert.equal(w.sent.length, 0);
  const stored = (await w.registry.comments.commentByExternalId('mastodon', '101'))!;
  assert.equal(stored.status, 'draft-ready');
  assert.equal(stored.classification, 'spam');
  assert.equal(stored.draft, null, 'whatever the model wrote, spam gets no reply');
});

test('approval mode drafts and never sends; auto mode sends the draft at once', async () => {
  const w = await world();
  w.thread = [comment('101', 'Does it run on Windows?')];
  const model = new MockLanguageModelV4({ doGenerate: async () => reply('Not yet, it is planned.') });
  const deps = replyDeps(w, model);
  assert.equal((await readCommentSettings(w.registry)).replies.mastodon, 'approval', 'approval by default');
  const approval = await runComments(deps);
  assert.equal(approval.drafted.length, 1);
  assert.equal(approval.sent.length, 0);
  assert.equal(w.sent.length, 0, 'nothing is sent without the owner’s click');

  w.thread = [...w.thread, comment('1033', 'And Linux?')];
  await writeCommentSettings(w.registry, { replies: { mastodon: 'auto' } });
  const auto = await runComments(deps);
  assert.equal(auto.drafted.length, 1, 'only the new comment is drafted');
  assert.equal(auto.sent.length, 1);
  assert.deepEqual(w.sent[0]!.target, { postExternalId: '100', commentExternalId: '1033', authorHandle: '@ana@fosstodon.org' });
  assert.equal((await w.registry.comments.commentByExternalId('mastodon', '1033'))!.status, 'sent');
  assert.equal((await w.registry.comments.commentByExternalId('mastodon', '101'))!.status, 'draft-ready', 'an earlier draft still waits for approval');
  assert.equal(deps.contexts, 2, 'one grounding per launch per run');
});

test('sending claims the comment first: a second approval sends nothing, and a refusal leaves it failed with the reason', async () => {
  const w = await world();
  w.thread = [comment('101', 'Hi'), comment('1022', 'Hello')];
  await fetchComments(w);
  const [a, b] = [(await w.registry.comments.commentByExternalId('mastodon', '101'))!, (await w.registry.comments.commentByExternalId('mastodon', '1022'))!];
  await assert.rejects(sendReply(a.id, w), (e: unknown) => e instanceof CommentRefused && e.reason === 'invalid', 'no draft, nothing to send');
  await editReplyDraft(a.id, 'Hi there!', w.registry);
  const [first, second] = await Promise.allSettled([sendReply(a.id, w), sendReply(a.id, w)]);
  assert.equal([first, second].filter((r) => r.status === 'fulfilled').length, 1, 'two clicks at once send once');
  assert.equal(w.sent.length, 1);
  assert.equal(w.sent[0]!.key, 'shipcast-reply-mastodon-101');
  const sent = (await w.registry.comments.comment(a.id))!;
  assert.equal(sent.status, 'sent');
  assert.equal(sent.sentUrl, 'https://mastodon.social/@me/r1');
  await assert.rejects(sendReply(a.id, w), (e: unknown) => e instanceof CommentRefused && e.reason === 'state');
  await assert.rejects(dismissComment(a.id, w.registry), (e: unknown) => e instanceof CommentRefused && e.reason === 'state');

  await editReplyDraft(b.id, 'this will fail', w.registry);
  await assert.rejects(sendReply(b.id, w), ConnectorError);
  const failed = (await w.registry.comments.comment(b.id))!;
  assert.equal(failed.status, 'failed');
  assert.match(failed.problem ?? '', /422/);
});

test('a draft over the network’s limit is refused, and dev.to never sends: auto there means approval', async () => {
  const w = await world('devto');
  w.thread = [comment('a1', 'Nice post')];
  await fetchComments(w);
  const c = (await w.registry.comments.commentByExternalId('devto', 'a1'))!;
  await assert.rejects(editReplyDraft(c.id, 'x'.repeat(601), w.registry), (e: unknown) => e instanceof CommentRefused && e.reason === 'invalid');
  await editReplyDraft(c.id, 'Thanks!', w.registry);
  await assert.rejects(sendReply(c.id, w), (e: unknown) => e instanceof CommentRefused && e.reason === 'unsupported');
  assert.equal((await writeCommentSettings(w.registry, { replies: { devto: 'auto' } })).replies.devto, 'approval');
  await assert.rejects(writeCommentSettings(w.registry, { replies: { telegram: 'auto' } }));
  assert.equal((await dismissComment(c.id, w.registry)).status, 'dismissed');
});

test('a draft the AI could not write leaves the comment failed with the reason, and the run goes on', async () => {
  const w = await world();
  w.thread = [comment('101', 'Hi')];
  const model = new MockLanguageModelV4({ doGenerate: async () => answer({ nope: true }) });
  const result = await runComments(replyDeps(w, model));
  assert.equal(result.drafted.length, 0);
  const stored = (await w.registry.comments.commentByExternalId('mastodon', '101'))!;
  assert.equal(stored.status, 'failed');
  assert.match(stored.problem ?? '', /not a reply|could not draft/);
});
