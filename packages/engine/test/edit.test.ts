import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConnectorError } from '@shipcast/connectors';
import {
  CAPABILITIES,
  contentHash,
  deleteLaunchPosts,
  deletePost,
  editPost,
  editPosts,
  PostRefused,
  type EditDeps,
  type Registry,
} from '../src/index.ts';
import type { Channel } from '@shipcast/schema';
import { FakeConnectors, FakeGitHub, memoryRegistry, type ConnectorCall } from '../src/testing/index.ts';

type Sent = ConnectorCall;

/** Every editor records what it was sent and with which account it was built; `fail` makes a channel's edits and deletes throw */
function fakeEditors(sent: Sent[], fail: Partial<Record<Channel, Error>> = {}): EditDeps['editors'] {
  const fake = new FakeConnectors(sent);
  for (const [channel, error] of Object.entries(fail) as Array<[Channel, Error]>) fake.fail(channel, 'edit', error).fail(channel, 'delete', error);
  return fake.editors();
}

const image = (async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } })) as unknown as typeof fetch;

async function launchWith(registry: Registry, channels: Array<{ channel: Parameters<Registry['posts']['recordPost']>[0]['channel']; kind?: Parameters<Registry['posts']['recordPost']>[0]['kind']; externalId: string; accountId?: number | null }>) {
  const { launch } = await registry.launches.claim({ repo: 'yeyo11/claudio', ref: 'v1.0.0', trigger: 'release', kind: 'launch', brand: 'personal' });
  await registry.launches.setStatus(launch.id, 'published');
  const posts = [];
  for (const c of channels) posts.push((await registry.posts.recordPost({ launchId: launch.id, channel: c.channel, kind: c.kind ?? 'post', externalId: c.externalId, url: `https://${c.channel}.example/${c.externalId}`, accountId: c.accountId ?? null })).post);
  return { launch, posts };
}

test('an edit goes out with the account the post was published with, and the row says edited with its hash', async () => {
  const registry = await memoryRegistry();
  const account = await registry.addAccount({ network: 'mastodon', brand: 'personal', label: '@old', settings: { instance: 'https://m.example' } });
  // A newer primary account must not be the one used
  await registry.addAccount({ network: 'mastodon', brand: 'personal', label: '@new', settings: { instance: 'https://m.example' } });
  const { posts } = await launchWith(registry, [{ channel: 'mastodon', externalId: '111', accountId: account.id }]);
  const sent: Sent[] = [];
  const before = posts[0]!;
  const changes = { text: 'Fixed', link: 'https://site.dev/en/x/' };

  const edited = await editPost(before.id, changes, { registry, editors: fakeEditors(sent) });
  assert.deepEqual(sent, [{ channel: 'mastodon', action: 'edit', id: '111', input: { text: 'Fixed\n\nhttps://site.dev/en/x/' }, accountId: account.id }]);
  assert.equal(edited.status, 'edited');
  assert.equal(edited.contentHash, contentHash(changes));
  assert.ok(edited.updatedAt >= before.updatedAt);
  assert.equal((await registry.posts.post(before.id))!.status, 'edited');
});

test('what a network cannot do is refused before any request, and the row is left as it was', async () => {
  const registry = await memoryRegistry();
  const { posts } = await launchWith(registry, [
    { channel: 'bluesky', externalId: 'at://did:plc:a/app.bsky.feed.post/1' },
    { channel: 'instagram', externalId: 'ig1' },
    { channel: 'instagram', kind: 'story', externalId: 'st1' },
    { channel: 'newsletter', kind: 'issue:en', externalId: '12' },
    { channel: 'discord', externalId: 'd1' },
  ]);
  const [bluesky, instagram, story, issue, discord] = posts;
  const sent: Sent[] = [];
  const deps = { registry, editors: fakeEditors(sent) };
  const refused = (reason: string, words: RegExp) => (e: unknown) => e instanceof PostRefused && e.reason === reason && words.test(e.message);

  await assert.rejects(editPost(bluesky!.id, { text: 'x' }, deps), refused('unsupported', /Bluesky cannot edit/));
  await assert.rejects(editPost(instagram!.id, { text: 'x' }, deps), refused('unsupported', /Instagram cannot edit/));
  await assert.rejects(deletePost(instagram!.id, deps), refused('unsupported', /Instagram cannot delete/));
  await assert.rejects(deletePost(issue!.id, deps), refused('unsupported', /newsletter cannot delete/i));
  await assert.rejects(editPost(story!.id, { text: 'x' }, deps), refused('unsupported', /Instagram cannot edit/));
  await assert.rejects(editPost(discord!.id, { imageUrl: 'https://x.dev/i.png' }, deps), refused('invalid', /Discord cannot change image/));
  await assert.rejects(editPost(discord!.id, { link: 'https://x.dev' }, deps), refused('invalid', /send the text with the link/));
  await assert.rejects(editPost(9999, { text: 'x' }, deps), refused('not_found', /no such post/));
  assert.equal(sent.length, 0);
  for (const post of posts) assert.equal((await registry.posts.post(post.id))!.status, 'live');
});

test('a post with no credentials for its account is refused, naming them', async () => {
  const registry = await memoryRegistry();
  const { posts } = await launchWith(registry, [{ channel: 'telegram', externalId: '@c:1' }]);
  await assert.rejects(
    editPost(posts[0]!.id, { text: 'x' }, { registry, editors: async () => ({}) }),
    (e) => e instanceof PostRefused && e.reason === 'no_credentials' && /credentials in \.env/.test(e.message),
  );
});

test('a deleted post stays a row, is not deleted or edited again, and its piece is never recorded twice', async () => {
  const registry = await memoryRegistry();
  const { launch, posts } = await launchWith(registry, [{ channel: 'devto', externalId: '42' }]);
  const sent: Sent[] = [];
  const deps = { registry, editors: fakeEditors(sent) };
  const deleted = await deletePost(posts[0]!.id, deps);
  assert.equal(deleted.status, 'deleted');
  assert.deepEqual(sent.map((s) => `${s.channel} ${s.action} ${s.id}`), ['devto delete 42']);
  await assert.rejects(deletePost(posts[0]!.id, deps), (e) => e instanceof PostRefused && e.reason === 'deleted');
  await assert.rejects(editPost(posts[0]!.id, { text: 'x' }, deps), (e) => e instanceof PostRefused && e.reason === 'deleted');
  const again = await registry.posts.recordPost({ launchId: launch.id, channel: 'devto', externalId: '43', url: 'https://devto.example/43' });
  assert.equal(again.recorded, false, 'a launch happens once, deleted or not');
});

test('a network that says the post is gone already counts as deleted; another failure leaves the row live', async () => {
  const registry = await memoryRegistry();
  const { posts } = await launchWith(registry, [
    { channel: 'mastodon', externalId: '1' },
    { channel: 'hashnode', externalId: 'h1' },
  ]);
  const deps = {
    registry,
    editors: fakeEditors([], { mastodon: new ConnectorError('Mastodon', 'delete: 404', 404), hashnode: new ConnectorError('Hashnode', 'delete: 500', 500) }),
  };
  assert.equal((await deletePost(posts[0]!.id, deps)).status, 'deleted');
  await assert.rejects(deletePost(posts[1]!.id, deps), /500/);
  assert.equal((await registry.posts.post(posts[1]!.id))!.status, 'live');
});

test('one change to several channels maps the shared fields to each network and reports what cannot take it', async () => {
  const registry = await memoryRegistry();
  const { launch } = await launchWith(registry, [
    { channel: 'mastodon', externalId: 'm1' },
    { channel: 'telegram', externalId: '@c:5' },
    { channel: 'discord', externalId: 'd1' },
    { channel: 'devto', externalId: '42' },
    { channel: 'hashnode', externalId: 'h1' },
    { channel: 'bluesky', externalId: 'at://did:plc:a/app.bsky.feed.post/1' },
    { channel: 'instagram', externalId: 'ig1' },
  ]);
  const sent: Sent[] = [];
  const outcomes = await editPosts(launch.id, { text: 'New text', link: 'https://site.dev/en/x/', imageUrl: 'https://site.dev/og.png', imageAlt: 'The cover' }, undefined, {
    registry,
    editors: fakeEditors(sent),
    fetch: image,
  });
  const input = (channel: string) => sent.find((s) => s.channel === channel)?.input;
  assert.deepEqual(input('mastodon'), {
    text: 'New text\n\nhttps://site.dev/en/x/',
    image: { bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png', filename: 'og.png', description: 'The cover' },
  });
  assert.deepEqual(input('telegram'), { text: 'New text\n\nhttps://site.dev/en/x/', imageUrl: 'https://site.dev/og.png' });
  assert.deepEqual(input('discord'), { content: 'New text\n\nhttps://site.dev/en/x/' }, 'Discord takes no image: the rest still goes');
  assert.deepEqual(input('devto'), { markdown: 'New text', canonicalUrl: 'https://site.dev/en/x/', mainImage: 'https://site.dev/og.png' });
  assert.deepEqual(input('hashnode'), { markdown: 'New text', canonicalUrl: 'https://site.dev/en/x/', coverImageUrl: 'https://site.dev/og.png' });
  assert.deepEqual(
    outcomes.map((o) => `${o.channel} ${o.ok ? o.post.status : o.reason}`),
    ['mastodon edited', 'telegram edited', 'discord edited', 'devto edited', 'hashnode edited', 'bluesky unsupported', 'instagram unsupported'],
  );
});

test('a launch-wide edit or delete can be limited to some channels', async () => {
  const registry = await memoryRegistry();
  const { launch, posts } = await launchWith(registry, [
    { channel: 'mastodon', externalId: 'm1' },
    { channel: 'bluesky', externalId: 'at://did:plc:a/app.bsky.feed.post/1' },
    { channel: 'telegram', externalId: '@c:5' },
  ]);
  const sent: Sent[] = [];
  const deps = { registry, editors: fakeEditors(sent) };
  const deleted = await deleteLaunchPosts(launch.id, ['mastodon', 'bluesky'], deps);
  assert.deepEqual(deleted.map((o) => `${o.channel} ${o.ok}`), ['mastodon true', 'bluesky true']);
  assert.equal((await registry.posts.post(posts[2]!.id))!.status, 'live');
  // Deleted pieces are left out of the next operation on the launch
  const edited = await editPosts(launch.id, { text: 'x' }, undefined, deps);
  assert.deepEqual(edited.map((o) => o.channel), ['telegram']);
  await assert.rejects(editPosts(999, { text: 'x' }, undefined, deps), (e) => e instanceof PostRefused && e.reason === 'not_found');
});

/** The launches repo with these files on main */
const launchesRepo = (files: Record<string, string>) => new FakeGitHub({ files: Object.fromEntries(Object.entries(files).map(([path, content]) => [FakeGitHub.key('yeyo11/launches', path), content])) });

test('the blog is edited by a commit that keeps the front matter and sets updatedDate', async () => {
  const registry = await memoryRegistry();
  const { posts } = await launchWith(registry, [{ channel: 'blog', kind: 'article:en', externalId: 'claudio' }]);
  const repo = launchesRepo({ 'src/content/posts/en/claudio.md': '---\ntitle: "Old"\ndescription: "D"\npubDate: 2026-10-01\n# kept\nlang: en\n---\n\nOld body.\n' });
  const edited = await editPost(posts[0]!.id, { title: 'New', text: 'New body.' }, { registry, editors: fakeEditors([]), blog: { github: repo, launchesRepo: 'yeyo11/launches' }, now: () => new Date('2026-10-25T10:00:00Z') });
  assert.equal(edited.status, 'edited');
  assert.deepEqual(repo.commits.map((c) => c.branch), ['main']);
  assert.equal(repo.file('yeyo11/launches', 'src/content/posts/en/claudio.md'), '---\ntitle: "New"\ndescription: "D"\npubDate: 2026-10-01\n# kept\nlang: en\nupdatedDate: 2026-10-25\n---\n\nNew body.\n');
  await assert.rejects(editPost(posts[0]!.id, { link: 'https://x.dev' }, { registry, editors: fakeEditors([]), blog: { github: repo, launchesRepo: 'yeyo11/launches' } }), /cannot change link/);
});

test('deleting an article removes it, and the launch media only with the last language', async () => {
  const registry = await memoryRegistry();
  const { posts } = await launchWith(registry, [
    { channel: 'blog', kind: 'article:en', externalId: 'claudio' },
    { channel: 'blog', kind: 'article:es', externalId: 'claudio-es' },
  ]);
  const media = 'public/launches/claudio/v1.0.0';
  const repo = launchesRepo({
    'src/content/posts/en/claudio.md': '---\ntitle: x\n---\n\nx\n',
    'src/content/posts/es/claudio-es.md': '---\ntitle: x\n---\n\nx\n',
    [`${media}/og.png`]: 'png',
    [`${media}/og.jpg`]: 'jpg',
    'public/launches/other/v1/og.png': 'png',
  });
  const deps = { registry, editors: fakeEditors([]), blog: { github: repo, launchesRepo: 'yeyo11/launches' } };
  await deletePost(posts[0]!.id, deps);
  assert.deepEqual(repo.commits[0]!.files, [{ path: 'src/content/posts/en/claudio.md', delete: true }], 'the Spanish article still shows the media');
  await deletePost(posts[1]!.id, deps);
  assert.deepEqual(repo.commits[1]!.files.map((f) => f.path).sort(), [`${media}/og.jpg`, `${media}/og.png`, 'src/content/posts/es/claudio-es.md']);
  assert.deepEqual(repo.commits.map((c) => c.branch), ['main', 'main']);
  assert.ok(repo.file('yeyo11/launches', 'public/launches/other/v1/og.png'), 'another launch’s media are not touched');
});

test('the capability map covers every channel, and says why where it refuses', () => {
  for (const [channel, capability] of Object.entries(CAPABILITIES)) {
    assert.ok(capability.note.length > 0, channel);
    assert.equal(capability.edit === 'no', capability.fields.length === 0, `${channel}: fields only where it edits`);
  }
  assert.deepEqual([CAPABILITIES.bluesky.edit, CAPABILITIES.bluesky.delete], ['no', 'yes']);
  assert.equal(CAPABILITIES.devto.delete, 'unpublish');
  assert.deepEqual([CAPABILITIES.instagram.edit, CAPABILITIES.instagram.delete, CAPABILITIES.newsletter.delete], ['no', 'no', 'no']);
});

test('a discussion takes a new title and body; Threads and LinkedIn delete but never edit', async () => {
  const registry = await memoryRegistry();
  const sent: Sent[] = [];
  const deps: EditDeps = { registry, editors: fakeEditors(sent) };
  const { posts } = await launchWith(registry, [
    { channel: 'githubDiscussions', externalId: 'D_1' },
    { channel: 'threads', externalId: 't1' },
    { channel: 'linkedin', externalId: 'urn:li:share:1' },
  ]);
  const [discussion, thread, linkedin] = posts;
  assert.equal((await editPost(discussion!.id, { title: 'New', text: 'New body' }, deps)).status, 'edited');
  assert.deepEqual(sent[0], { channel: 'githubDiscussions', action: 'edit', id: 'D_1', input: { title: 'New', body: 'New body' }, accountId: null });
  for (const post of [thread!, linkedin!]) {
    await assert.rejects(editPost(post.id, { text: 'x' }, deps), (e) => e instanceof PostRefused && e.reason === 'unsupported');
  }
  for (const post of [discussion!, thread!, linkedin!]) assert.equal((await deletePost(post.id, deps)).status, 'deleted');
  assert.deepEqual(
    sent.filter((s) => s.action === 'delete').map((s) => [s.channel, s.id]),
    [['githubDiscussions', 'D_1'], ['threads', 't1'], ['linkedin', 'urn:li:share:1']],
  );
  assert.match(CAPABILITIES.linkedin.note, /Community Management API/);
});
