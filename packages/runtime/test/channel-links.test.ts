import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adapterOf } from '../src/index.ts';

/*
 * The links each channel's adapter hands its network (docs/tracking.md): every link to the site in
 * a post's text, its link card or its embed carries the network and the launch's campaign, and
 * loses the `?ref=` Claude wrote; links elsewhere go out as written.
 */

const ARTICLE = 'https://josegarrido.dev/en/claudio/';
const tracking = { site: 'https://josegarrido.dev', campaign: 'claudio-v1-0-0' };
/** The article's link as a channel tags it */
const tagged = (source: string, medium = 'social', content?: string) =>
  `${ARTICLE}?utm_source=${source}&utm_medium=${medium}&utm_campaign=claudio-v1-0-0${content ? `&utm_content=${content}` : ''}`;

/** A connector that answers every call and keeps what it was given */
function recorder() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const connector = new Proxy({} as Record<string, unknown>, {
    get: (_target, method: string) => async (...args: unknown[]) => {
      calls.push({ method, args });
      return { externalId: 'x', url: 'https://network.example/x' };
    },
  });
  return { connector, calls };
}

/** The adapter's publisher over a recording connector, and what reached the connector */
function publisherOf(channel: string) {
  const adapter = adapterOf(channel);
  assert.ok(adapter, channel);
  const { connector, calls } = recorder();
  return { publisher: adapter.publisher(connector) as Record<string, (...args: unknown[]) => Promise<unknown>>, sent: () => calls.map((c) => c.args[0]) };
}

test('Bluesky: the text’s link and the link card are tagged', async () => {
  const { publisher, sent } = publisherOf('bluesky');
  await publisher.publish!({ text: `New: ${ARTICLE}?ref=bluesky`, lang: 'en', link: { url: ARTICLE, title: 'T', description: 'D' } }, tracking);
  assert.deepEqual(sent(), [{ text: `New: ${tagged('bluesky')}`, lang: 'en', link: { url: tagged('bluesky'), title: 'T', description: 'D' } }]);
});

test('without tracking a channel’s links go out as the engine wrote them', async () => {
  const { publisher, sent } = publisherOf('bluesky');
  await publisher.publish!({ text: `New: ${ARTICLE}?ref=bluesky`, lang: 'en', link: { url: ARTICLE, title: 'T', description: 'D' } });
  assert.deepEqual(sent(), [{ text: `New: ${ARTICLE}?ref=bluesky`, lang: 'en', link: { url: ARTICLE, title: 'T', description: 'D' } }]);
});

test('Mastodon: the text’s link is tagged', async () => {
  const { publisher, sent } = publisherOf('mastodon');
  await publisher.publish!({ text: `New: ${ARTICLE}?ref=mastodon #rust`, lang: 'en', idempotencyKey: 'k' }, tracking);
  assert.deepEqual(sent(), [{ text: `New: ${tagged('mastodon')} #rust`, lang: 'en', idempotencyKey: 'k' }]);
});

test('Threads and Telegram: the text’s link is tagged, unless the tags would push it over the limit', async () => {
  for (const [channel, limit] of [['threads', 500], ['telegram', 900]] as const) {
    const { publisher, sent } = publisherOf(channel);
    await publisher.publish!({ text: `New: ${ARTICLE}?ref=${channel}`, imageUrl: 'https://josegarrido.dev/og.jpg' }, tracking);
    const full = `${'a'.repeat(limit - `${ARTICLE}?ref=${channel}`.length - 1)} ${ARTICLE}?ref=${channel}`;
    await publisher.publish!({ text: full }, tracking);
    assert.deepEqual(sent(), [{ text: `New: ${tagged(channel)}`, imageUrl: 'https://josegarrido.dev/og.jpg' }, { text: full }], channel);
  }
});

test('Discord: the message’s link and the embed are tagged; a full message keeps its ?ref=', async () => {
  const { publisher, sent } = publisherOf('discord');
  await publisher.publish!({ content: `New: ${ARTICLE}?ref=discord`, embed: { title: 'T', url: ARTICLE, description: 'D' } }, tracking);
  const full = `${'a'.repeat(2000 - `${ARTICLE}?ref=discord`.length - 1)} ${ARTICLE}?ref=discord`;
  await publisher.publish!({ content: full, embed: { title: 'T', url: ARTICLE, description: 'D' } }, tracking);
  assert.deepEqual(sent(), [
    { content: `New: ${tagged('discord')}`, embed: { title: 'T', url: tagged('discord'), description: 'D' } },
    { content: full, embed: { title: 'T', url: tagged('discord'), description: 'D' } },
  ]);
});

test('LinkedIn: the shared article’s link is tagged', async () => {
  const { publisher, sent } = publisherOf('linkedin');
  await publisher.publish!({ text: 'Shipped it.', article: { url: `${ARTICLE}?ref=linkedin`, title: 'T', description: 'D' } }, tracking);
  assert.deepEqual(sent(), [{ text: 'Shipped it.', article: { url: tagged('linkedin'), title: 'T', description: 'D' } }]);
});

test('Reddit: each subreddit’s body is tagged with its subreddit', async () => {
  const { publisher, sent } = publisherOf('reddit');
  await publisher.publish!({ subreddit: 'selfhosted', title: 'T', text: `Body\n\n${ARTICLE}?ref=reddit` }, tracking);
  assert.deepEqual(sent(), [{ subreddit: 'selfhosted', title: 'T', text: `Body\n\n${tagged('reddit', 'social', 'selfhosted')}` }]);
});

test('GitHub Discussions: the body’s Markdown link is tagged', async () => {
  const { publisher, sent } = publisherOf('githubDiscussions');
  await publisher.publish!({ repo: 'yeyo11/claudio', title: 'T', body: `Read [the article](${ARTICLE}?ref=github).` }, tracking);
  assert.deepEqual(sent(), [{ repo: 'yeyo11/claudio', title: 'T', body: `Read [the article](${tagged('github')}).` }]);
});

test('Newsletter: the issue’s links to the site are tagged with its language', async () => {
  const { publisher, sent } = publisherOf('newsletter');
  const html = `<a href="${ARTICLE}?ref=newsletter">Read</a> <a href="https://github.com/yeyo11/claudio">repo</a>`;
  await publisher.send!({ name: 'n', subject: 's', previewText: 'p', html, sender: { name: 'Me', email: 'me@example.test' }, listId: 1 }, { ...tracking, lang: 'es' });
  const issue = `<a href="${tagged('newsletter', 'email', 'es').replaceAll('&', '&amp;')}">Read</a> <a href="https://github.com/yeyo11/claudio">repo</a>`;
  assert.deepEqual(sent(), [{ name: 'n', subject: 's', previewText: 'p', html: issue, sender: { name: 'Me', email: 'me@example.test' }, listId: 1 }]);
});

test('dev.to and Hashnode: the canonical URL and the article go out clean', async () => {
  for (const channel of ['devto', 'hashnode']) {
    const { publisher, sent } = publisherOf(channel);
    const article = { title: 'T', markdown: `See ${ARTICLE}`, tags: ['x'], canonicalUrl: ARTICLE };
    await publisher.publish!(article, tracking);
    assert.deepEqual(sent(), [article], channel);
  }
});

test('YouTube: the description’s links are tagged with the video’s format, unless the tags would push it over 5000', async () => {
  const adapter = adapterOf('youtube');
  assert.ok(adapter);
  const uploads: Array<{ description: string; short: boolean }> = [];
  const connection = {
    youtube: { publish: async (video: { description: string; short: boolean }) => (uploads.push(video), { externalId: 'x', url: 'https://www.youtube.com/watch?v=x', extras: [] }) },
    quota: { ensureUpload: async () => undefined },
  };
  const publisher = adapter.publisher(connection) as { publish(video: { description: string; short: boolean }, tracking?: { site: string; campaign: string }): Promise<unknown> };
  const description = `${ARTICLE}?ref=youtube\n\nWhat claudio does. Code: https://github.com/yeyo11/claudio`;
  await publisher.publish({ description, short: true }, tracking);
  await publisher.publish({ description, short: false }, tracking);
  const full = `${ARTICLE}?ref=youtube\n\n${'a'.repeat(5000 - `${ARTICLE}?ref=youtube`.length - 2)}`;
  await publisher.publish({ description: full, short: false }, tracking);
  await publisher.publish({ description, short: true });
  assert.deepEqual(uploads.map((u) => u.description), [
    `${tagged('youtube', 'social', 'short')}\n\nWhat claudio does. Code: https://github.com/yeyo11/claudio`,
    `${tagged('youtube', 'social', 'video')}\n\nWhat claudio does. Code: https://github.com/yeyo11/claudio`,
    full,
    description,
  ]);
});

test('edits: each channel that edits tags the edited text as its post was, with the same limits and format', async () => {
  const editorOf = (channel: string, connector: unknown) => adapterOf(channel)!.editor!(connector as never) as { edit(id: string, e: unknown, tracking?: unknown): Promise<void> };
  const sent: Array<[string, unknown]> = [];
  const keep = (channel: string) => ({ edit: async (_id: string, e: unknown) => void sent.push([channel, e]), delete: async () => undefined });
  const edit = { ...tracking, kind: 'post' };
  await editorOf('mastodon', keep('mastodon')).edit('m', { text: `Fixed ${ARTICLE}?ref=mastodon` }, edit);
  await editorOf('telegram', keep('telegram')).edit('t', { text: `Fixed ${ARTICLE}?ref=telegram` }, edit);
  const full = `${'a'.repeat(900 - `${ARTICLE}?ref=telegram`.length - 1)} ${ARTICLE}?ref=telegram`;
  await editorOf('telegram', keep('telegram')).edit('t', { text: full }, edit);
  await editorOf('discord', keep('discord')).edit('d', { content: `Fixed ${ARTICLE}?ref=discord` }, edit);
  await editorOf('githubDiscussions', keep('githubDiscussions')).edit('g', { title: 'T', body: `Read [it](${ARTICLE}?ref=github).` }, edit);
  await editorOf('mastodon', keep('mastodon')).edit('m', { text: `As written ${ARTICLE}?ref=mastodon` });
  await editorOf('youtube', { youtube: keep('youtube') }).edit('y', { text: `${ARTICLE}?ref=youtube\n\nWhat it shows.` }, { ...tracking, kind: 'post:short' });
  await editorOf('youtube', { youtube: keep('youtube') }).edit('y', { title: 'Only the title' }, { ...tracking, kind: 'post:video' });
  assert.deepEqual(sent, [
    ['mastodon', { text: `Fixed ${tagged('mastodon')}` }],
    ['telegram', { text: `Fixed ${tagged('telegram')}` }],
    ['telegram', { text: full }],
    ['discord', { content: `Fixed ${tagged('discord')}` }],
    ['githubDiscussions', { title: 'T', body: `Read [it](${tagged('github')}).` }],
    ['mastodon', { text: `As written ${ARTICLE}?ref=mastodon` }],
    ['youtube', { description: `${tagged('youtube', 'social', 'short')}\n\nWhat it shows.` }],
    ['youtube', { title: 'Only the title' }],
  ]);
});
