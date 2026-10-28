import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contentHash, editPosts, type Registry } from '@shipcast/engine';
import { aPublishedLaunch, FakeConnectors, FakeGitHub, memoryRegistry, withScheduled } from '@shipcast/engine/testing';
import { editMany, type PostActionDeps } from '../src/server/post-actions.ts';

/*
 * Characterisation of the multi-edit, first pinned while the launch page's `editMany`
 * (post-actions.ts) re-implemented the engine's `editPosts` (docs/plans/performance-refactor.md,
 * "Code structure"). Both now run the one `editPosts`, through PostService; what still differs is
 * on purpose, and pinned here:
 * - the API selects by channels and skips deleted and scheduled pieces without a word; the page
 *   selects by post ids, in the order given, and reports those pieces as refused (PostSelection);
 * - a title or tags go to the networks that have one through the API, while the page's request
 *   offers the shared fields only and refuses the request whole (editManyRequest);
 * - both edit non-strictly, one piece at a time, and hash only the fields each network took.
 */

async function world() {
  const registry = await memoryRegistry();
  const fake = new FakeConnectors();
  const { launch, posts } = await aPublishedLaunch(registry, [
    { channel: 'mastodon', externalId: 'm1' },
    { channel: 'devto', externalId: '42' },
    { channel: 'bluesky', externalId: 'at://b1' },
    { channel: 'telegram', externalId: '@c:5', status: 'deleted' },
  ]);
  const [discord] = await withScheduled(registry, launch.id, { discord: new Date('2099-01-01T00:00:00Z') });
  const editing = { registry, editors: fake.editors() };
  const deps: PostActionDeps = { registry, editing: async () => editing, armSchedule: async () => {}, github: new FakeGitHub(), launchesRepo: 'yeyo11/launches' };
  const [mastodon, devto, bluesky, telegram] = posts;
  return { registry, fake, launch, editing, deps, mastodon: mastodon!, devto: devto!, bluesky: bluesky!, telegram: telegram!, discord: discord! };
}

const statusOf = async (registry: Registry, id: number) => (await registry.post(id))?.status;

test('by channels editPosts skips deleted and scheduled pieces silently; by the page’s ids it reports them, in the order asked', async () => {
  const w = await world();
  const changes = { text: 'New text', link: 'https://josegarrido.dev/en/claudio/' };

  const engine = await editPosts(w.launch.id, changes, undefined, w.editing);
  assert.deepEqual(engine.map((o) => `${o.channel} ${o.ok ? o.post.status : o.reason}`).sort(), ['bluesky unsupported', 'devto edited', 'mastodon edited']);

  const page = await editMany(w.deps, { launchId: w.launch.id, postIds: [w.telegram.id, w.discord.id, w.devto.id, w.bluesky.id, w.mastodon.id], changes });
  assert.ok(page.ok);
  assert.deepEqual(
    page.value.map((o) => `${o.channel} ${o.ok ? o.piece.status : o.reason}`),
    ['telegram deleted', 'discord unsupported', 'devto edited', 'bluesky unsupported', 'mastodon edited'],
  );
  const scheduled = page.value[1];
  assert.match(scheduled && !scheduled.ok ? scheduled.problem : '', /is scheduled and not out yet: move or cancel its schedule instead/);
  assert.deepEqual([...w.fake.log].sort(), ['devto edit 42', 'devto edit 42', 'mastodon edit m1', 'mastodon edit m1'], 'each path sent its two edits, nothing for the refused');
  assert.equal(await statusOf(w.registry, w.discord.id), 'scheduled');
});

test('a title goes to the networks that have one through editPosts, while editMany refuses the request whole', async () => {
  const w = await world();
  const engine = await editPosts(w.launch.id, { title: 'New title' }, ['mastodon', 'devto'], w.editing);
  assert.deepEqual(engine.map((o) => `${o.channel} ${o.ok ? o.post.status : o.reason}`).sort(), ['devto edited', 'mastodon invalid']);
  assert.deepEqual(w.fake.callsOf('devto')[0]?.input, { title: 'New title' });

  const page = await editMany(w.deps, { launchId: w.launch.id, postIds: [w.devto.id], changes: { title: 'New title' } });
  assert.deepEqual(page, { ok: false, problem: 'several pieces at once share the text, the link and the image only', reason: 'invalid' });
  assert.equal(w.fake.calls.length, 1, 'nothing sent by the refused request');
});

test('each piece’s hash is of the fields its network took, on both paths', async () => {
  const w = await world();
  const changes = { text: 'T', imageUrl: 'https://josegarrido.dev/og.png', imageAlt: 'alt' };
  await editPosts(w.launch.id, changes, ['devto'], w.editing);
  assert.equal((await w.registry.post(w.devto.id))?.contentHash, contentHash({ text: 'T', imageUrl: 'https://josegarrido.dev/og.png', imageAlt: 'alt' }));
  await editMany(w.deps, { launchId: w.launch.id, postIds: [w.devto.id], changes: { text: 'T' } });
  assert.equal((await w.registry.post(w.devto.id))?.contentHash, contentHash({ text: 'T' }));
});
