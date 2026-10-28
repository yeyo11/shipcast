import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConnectorError } from '@shipcast/connectors';
import type { Editors, Registry } from '@shipcast/engine';
import { FakeGitHub, memoryRegistry } from '@shipcast/engine/testing';
import { cancel, deleteAll, deleteOne, editMany, editOne, move, recommend, schedule, type PostActionDeps } from '../src/server/post-actions.ts';

/*
 * The launch page's server functions, on PGlite with fake connectors: what reaches a network, what
 * the registry keeps, and that every refusal comes back as data the page can explain.
 */

async function setup() {
  const registry = await memoryRegistry();
  const sent: string[] = [];
  const armed: string[] = [];
  const fake = (channel: string) => ({
    edit: async (id: string, input: unknown) => {
      if (id === 'refused') throw new ConnectorError('Mastodon', 'edit: 422 Text is too long', 422);
      sent.push(`edit ${channel} ${id} ${JSON.stringify(input)}`);
    },
    delete: async (id: string) => {
      sent.push(`delete ${channel} ${id}`);
    },
  });
  const deps: PostActionDeps = {
    registry,
    editing: async () => ({
      registry,
      editors: async (channel) => ({ [channel]: channel === 'bluesky' ? { delete: fake('bluesky').delete } : fake(channel) }) as Editors,
    }),
    armSchedule: async (posts) => {
      for (const p of posts) armed.push(`${p.channel} ${p.scheduledAt}`);
    },
    // No launch.yml to read: scheduling leaves that check to the publish step
    github: new FakeGitHub().failOn('fileAt', new Error('404')),
    launchesRepo: 'yeyo11/launches',
  };
  return { registry, deps, sent, armed };
}

async function published(registry: Registry) {
  const { launch } = await registry.claim({ repo: 'yeyo11/claudio', ref: 'v2.0.0', trigger: 'release', kind: 'launch', brand: 'personal' });
  await registry.setStatus(launch.id, 'published');
  const record = async (channel: 'mastodon' | 'bluesky' | 'telegram' | 'devto' | 'instagram', externalId: string) =>
    (await registry.recordPost({ launchId: launch.id, channel, externalId, url: `https://${channel}.example/${externalId}` })).post;
  return { launch, mastodon: await record('mastodon', 'm1'), bluesky: await record('bluesky', 'at://did:plc:me/app.bsky.feed.post/b1'), telegram: await record('telegram', '11'), devto: await record('devto', '42'), instagram: await record('instagram', 'ig1') };
}

test('one piece is edited and then deleted through its connector, and its row says so', async () => {
  const s = await setup();
  const { mastodon } = await published(s.registry);
  const edited = await editOne(s.deps, { postId: mastodon.id, changes: { text: 'Claudio 2.0, now with themes' } });
  assert.equal(edited.ok, true);
  assert.equal(edited.ok && edited.value.status, 'edited');
  assert.match(s.sent[0] ?? '', /^edit mastodon m1 .*Claudio 2\.0, now with themes/);
  const gone = await deleteOne(s.deps, { postId: mastodon.id });
  assert.equal(gone.ok && gone.value.status, 'deleted');
  assert.equal(s.sent[1], 'delete mastodon m1');
  assert.equal((await s.registry.post(mastodon.id))?.status, 'deleted');
  const again = await editOne(s.deps, { postId: mastodon.id, changes: { text: 'x' } });
  assert.deepEqual(again.ok ? null : again.reason, 'deleted', 'a deleted piece is never edited');
});

test('what a network cannot do, a bad request and a network’s refusal all come back as problems, never as thrown errors', async () => {
  const s = await setup();
  const { launch, bluesky, instagram } = await published(s.registry);
  const noEdit = await editOne(s.deps, { postId: bluesky.id, changes: { text: 'x' } });
  assert.equal(!noEdit.ok && noEdit.reason, 'unsupported');
  assert.match(!noEdit.ok ? noEdit.problem : '', /Bluesky/);
  const noDelete = await deleteOne(s.deps, { postId: instagram.id });
  assert.equal(!noDelete.ok && noDelete.reason, 'unsupported');
  assert.equal(((await editOne(s.deps, { postId: 'one', changes: {} })) as { reason?: string }).reason, 'invalid');
  assert.equal(((await editOne(s.deps, { postId: 99999, changes: { text: 'x' } })) as { reason?: string }).reason, 'not_found');
  const { post: refused } = await s.registry.recordPost({ launchId: launch.id, channel: 'mastodon', kind: 'post', accountId: (await s.registry.addAccount({ network: 'mastodon', brand: 'personal', label: '@b', settings: {} })).id, externalId: 'refused', url: null });
  const upstream = await editOne(s.deps, { postId: refused.id, changes: { text: 'x'.repeat(10) } });
  assert.equal(!upstream.ok && upstream.reason, 'upstream');
  assert.match(!upstream.ok ? upstream.problem : '', /Text is too long/);
  assert.equal(s.sent.length, 0, 'nothing reached a network');
});

test('several pieces take the same shared fields, each network what it has; one refusal never stops the rest', async () => {
  const s = await setup();
  const { launch, mastodon, bluesky, telegram, devto } = await published(s.registry);
  const { launch: other } = await s.registry.claim({ repo: 'yeyo11/other', ref: 'v1.0.0', trigger: 'release', kind: 'launch', brand: 'personal' });
  const { post: foreign } = await s.registry.recordPost({ launchId: other.id, channel: 'mastodon', externalId: 'f1', url: 'https://m/f1' });
  const answer = await editMany(s.deps, { launchId: launch.id, postIds: [mastodon.id, bluesky.id, telegram.id, devto.id, foreign.id, mastodon.id], changes: { text: 'Shared text', link: 'https://josegarrido.dev/en/blog/claudio' } });
  assert.equal(answer.ok, true);
  const outcomes = answer.ok ? answer.value : [];
  assert.deepEqual(
    outcomes.map((o) => [o.channel, o.ok ? o.piece.status : o.reason]),
    [
      ['mastodon', 'edited'],
      ['bluesky', 'unsupported'],
      ['telegram', 'edited'],
      ['devto', 'edited'],
      ['mastodon', 'not_found'],
    ],
    'the same piece twice is edited once, and another launch’s piece is refused',
  );
  assert.equal(s.sent.length, 3);
  assert.match(s.sent.find((l) => l.startsWith('edit devto')) ?? '', /canonical|josegarrido\.dev/);
  const titled = await editMany(s.deps, { launchId: launch.id, postIds: [devto.id], changes: { title: 'A title' } });
  assert.equal(!titled.ok && titled.reason, 'invalid', 'a title is an article’s own, not a shared field');
  const none = await editMany(s.deps, { launchId: launch.id, postIds: [], changes: { text: 'x' } });
  assert.equal(!none.ok && none.reason, 'invalid');
  const missing = await editMany(s.deps, { launchId: 99999, postIds: [mastodon.id], changes: { text: 'x' } });
  assert.equal(!missing.ok && missing.reason, 'not_found');
});

test('deleting everything asks for the repo’s name, then deletes what each network allows and reports the rest', async () => {
  const s = await setup();
  const { launch, instagram } = await published(s.registry);
  const wrong = await deleteAll(s.deps, { launchId: launch.id, confirm: 'claudio' });
  assert.equal(!wrong.ok && wrong.reason, 'invalid');
  assert.equal(s.sent.length, 0);
  const answer = await deleteAll(s.deps, { launchId: launch.id, confirm: ' yeyo11/claudio ' });
  assert.equal(answer.ok, true);
  const outcomes = answer.ok ? answer.value : [];
  assert.deepEqual(outcomes.filter((o) => o.ok).map((o) => o.channel).sort(), ['bluesky', 'devto', 'mastodon', 'telegram']);
  assert.deepEqual(
    outcomes.filter((o) => !o.ok).map((o) => o.channel),
    ['instagram'],
  );
  assert.equal((await s.registry.post(instagram.id))?.status, 'live');
  assert.deepEqual(s.sent.sort(), ['delete bluesky at://did:plc:me/app.bsky.feed.post/b1', 'delete devto 42', 'delete mastodon m1', 'delete telegram 11']);
});

test('a drafted launch’s channel is scheduled, moved and cancelled, armed each time; what has no time is refused', async () => {
  const s = await setup();
  const { launch } = await s.registry.claim({ repo: 'yeyo11/claudio', ref: 'v3.0.0', trigger: 'release', kind: 'launch', brand: 'personal' });
  await s.registry.setStatus(launch.id, 'drafted', 'https://github.com/yeyo11/launches/pull/9');
  const when = new Date(Date.now() + 2 * 86_400_000);
  const scheduled = await schedule(s.deps, { launchId: launch.id, channel: 'mastodon', at: when.toISOString() });
  assert.equal(scheduled.ok, true);
  const piece = scheduled.ok ? scheduled.value : undefined;
  assert.equal(piece?.status, 'scheduled');
  assert.equal(piece?.scheduledAt, when.toISOString());
  const later = new Date(when.getTime() + 3_600_000);
  const moved = await move(s.deps, { postId: piece?.id, at: later.toISOString() });
  assert.equal(moved.ok && moved.value.scheduledAt, later.toISOString());
  assert.deepEqual(s.armed, [`mastodon ${when.toISOString()}`, `mastodon ${later.toISOString()}`]);
  const cancelled = await cancel(s.deps, { postId: piece?.id });
  assert.equal(cancelled.ok, true);
  assert.deepEqual(await s.registry.posts(launch.id), []);

  const reddit = await schedule(s.deps, { launchId: launch.id, channel: 'reddit', at: when.toISOString() });
  assert.equal(!reddit.ok && reddit.reason, 'invalid', 'Reddit is always a draft: it has no time');
  const noOffset = await schedule(s.deps, { launchId: launch.id, channel: 'mastodon', at: '2026-10-27T17:00' });
  assert.equal(!noOffset.ok && noOffset.reason, 'invalid', 'a time without its offset is nobody’s time');
  const tooFar = await schedule(s.deps, { launchId: launch.id, channel: 'mastodon', at: new Date(Date.now() + 90 * 86_400_000).toISOString() });
  assert.equal(tooFar.ok, false);
  const { launch: done } = await s.registry.claim({ repo: 'yeyo11/claudio', ref: 'v4.0.0', trigger: 'release', kind: 'launch', brand: 'personal' });
  await s.registry.setStatus(done.id, 'published');
  const late = await schedule(s.deps, { launchId: done.id, channel: 'mastodon', at: when.toISOString() });
  assert.equal(late.ok, false, 'a published launch has nothing left to schedule');
});

test('the recommended times come in the owner’s zone, at most five, for a channel Shipcast publishes', async () => {
  const s = await setup();
  const answer = await recommend(s.deps, { channel: 'bluesky' });
  assert.equal(answer.ok, true);
  const value = answer.ok ? answer.value : undefined;
  assert.equal(value?.timezone, 'Europe/Madrid');
  assert.ok((value?.slots.length ?? 0) > 0 && (value?.slots.length ?? 0) <= 5);
  assert.match(value?.slots[0]?.local ?? '', /^\w{3} \d{4}-\d{2}-\d{2} \d{2}:00$/);
  const blog = await recommend(s.deps, { channel: 'blog' });
  assert.equal(!blog.ok && blog.reason, 'invalid');
});
