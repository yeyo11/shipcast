import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adapterOf } from '../src/index.ts';

/*
 * The links each channel's adapter hands its network, as the engine gives them: what goes out of
 * Shipcast in a post's text, its link card or its embed.
 */

const ARTICLE = 'https://josegarrido.dev/en/claudio/';
const tracking = { site: 'https://josegarrido.dev', campaign: 'claudio-v1-0-0' };

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

test('Bluesky: the text and the link card go out as the engine wrote them', async () => {
  const { publisher, sent } = publisherOf('bluesky');
  await publisher.publish!({ text: `New: ${ARTICLE}?ref=bluesky`, lang: 'en', link: { url: ARTICLE, title: 'T', description: 'D' } }, tracking);
  assert.deepEqual(sent(), [{ text: `New: ${ARTICLE}?ref=bluesky`, lang: 'en', link: { url: ARTICLE, title: 'T', description: 'D' } }]);
});

test('Mastodon: the text goes out as written', async () => {
  const { publisher, sent } = publisherOf('mastodon');
  await publisher.publish!({ text: `New: ${ARTICLE}?ref=mastodon #rust`, lang: 'en', idempotencyKey: 'k' }, tracking);
  assert.deepEqual(sent(), [{ text: `New: ${ARTICLE}?ref=mastodon #rust`, lang: 'en', idempotencyKey: 'k' }]);
});

test('Threads and Telegram: the text goes out as written', async () => {
  for (const channel of ['threads', 'telegram']) {
    const { publisher, sent } = publisherOf(channel);
    await publisher.publish!({ text: `New: ${ARTICLE}?ref=${channel}`, imageUrl: 'https://josegarrido.dev/og.jpg' }, tracking);
    assert.deepEqual(sent(), [{ text: `New: ${ARTICLE}?ref=${channel}`, imageUrl: 'https://josegarrido.dev/og.jpg' }], channel);
  }
});

test('Discord: the message and the embed go out as written', async () => {
  const { publisher, sent } = publisherOf('discord');
  await publisher.publish!({ content: `New: ${ARTICLE}?ref=discord`, embed: { title: 'T', url: ARTICLE, description: 'D' } }, tracking);
  assert.deepEqual(sent(), [{ content: `New: ${ARTICLE}?ref=discord`, embed: { title: 'T', url: ARTICLE, description: 'D' } }]);
});

test('LinkedIn: the text and the shared article go out as written', async () => {
  const { publisher, sent } = publisherOf('linkedin');
  await publisher.publish!({ text: 'Shipped it.', article: { url: `${ARTICLE}?ref=linkedin`, title: 'T', description: 'D' } }, tracking);
  assert.deepEqual(sent(), [{ text: 'Shipped it.', article: { url: `${ARTICLE}?ref=linkedin`, title: 'T', description: 'D' } }]);
});

test('Reddit: each subreddit’s body goes out as written', async () => {
  const { publisher, sent } = publisherOf('reddit');
  await publisher.publish!({ subreddit: 'selfhosted', title: 'T', text: `Body\n\n${ARTICLE}?ref=reddit` }, tracking);
  assert.deepEqual(sent(), [{ subreddit: 'selfhosted', title: 'T', text: `Body\n\n${ARTICLE}?ref=reddit` }]);
});

test('GitHub Discussions: the body goes out as written', async () => {
  const { publisher, sent } = publisherOf('githubDiscussions');
  await publisher.publish!({ repo: 'yeyo11/claudio', title: 'T', body: `Read [the article](${ARTICLE}?ref=github).` }, tracking);
  assert.deepEqual(sent(), [{ repo: 'yeyo11/claudio', title: 'T', body: `Read [the article](${ARTICLE}?ref=github).` }]);
});

test('Newsletter: the issue’s HTML goes out as rendered', async () => {
  const { publisher, sent } = publisherOf('newsletter');
  const html = `<a href="${ARTICLE}?ref=newsletter">Read</a> <a href="https://github.com/yeyo11/claudio">repo</a>`;
  await publisher.send!({ name: 'n', subject: 's', previewText: 'p', html, sender: { name: 'Me', email: 'me@example.test' }, listId: 1 }, { ...tracking, lang: 'es' });
  assert.deepEqual(sent(), [{ name: 'n', subject: 's', previewText: 'p', html, sender: { name: 'Me', email: 'me@example.test' }, listId: 1 }]);
});

test('dev.to and Hashnode: the canonical URL and the article go out clean', async () => {
  for (const channel of ['devto', 'hashnode']) {
    const { publisher, sent } = publisherOf(channel);
    const article = { title: 'T', markdown: `See ${ARTICLE}`, tags: ['x'], canonicalUrl: ARTICLE };
    await publisher.publish!(article, tracking);
    assert.deepEqual(sent(), [article], channel);
  }
});
