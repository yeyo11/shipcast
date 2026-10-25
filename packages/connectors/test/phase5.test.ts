import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConnectorError, Discord, Hashnode, Telegram } from '../src/index.ts';
import { fakeFetch, sequence, type Call } from './fake.ts';

const gql = (data: unknown) => () => Response.json({ data });

test('Hashnode publishes with the blog as original URL, slugged tags and the bare token', async () => {
  const calls: Call[] = [];
  const hashnode = new Hashnode({
    token: 'tok',
    publicationHost: 'blog.example.dev',
    fetch: fakeFetch(
      [
        [
          'POST https://gql.hashnode.com',
          sequence(gql({ publication: { id: 'pub1' } }), gql({ publishPost: { post: { id: 'p1', url: 'https://blog.example.dev/claudio' } } })),
        ],
      ],
      calls,
    ),
  });
  const published = await hashnode.publish({
    title: 'claudio',
    markdown: 'Body',
    tags: ['Open Source'],
    canonicalUrl: 'https://josegarrido.dev/en/claudio/',
    coverImageUrl: 'https://josegarrido.dev/og.jpg',
  });
  assert.deepEqual(published, { externalId: 'p1', url: 'https://blog.example.dev/claudio' });
  assert.equal(calls[1]!.headers['authorization'], 'tok');
  const { input } = JSON.parse(String(calls[1]!.body)).variables;
  assert.deepEqual(input, {
    publicationId: 'pub1',
    title: 'claudio',
    contentMarkdown: 'Body',
    tags: [{ slug: 'open-source', name: 'Open Source' }],
    originalArticleURL: 'https://josegarrido.dev/en/claudio/',
    coverImageOptions: { coverImageURL: 'https://josegarrido.dev/og.jpg' },
  });
});

test('Hashnode maps metrics and turns GraphQL errors into refusals', async () => {
  const ok = new Hashnode({ token: 't', publicationId: 'p', fetch: fakeFetch([['POST', gql({ post: { views: 90, reactionCount: 4, responseCount: 2 } })]], []) });
  assert.deepEqual(await ok.metrics('p1'), { views: 90, reactions: 4, comments: 2 });

  const denied = new Hashnode({
    token: 'bad',
    publicationId: 'p',
    fetch: fakeFetch([['POST', () => Response.json({ errors: [{ message: 'no', extensions: { code: 'UNAUTHENTICATED' } }] })]], []),
  });
  await assert.rejects(denied.metrics('x'), (e) => e instanceof ConnectorError && e.status === 401 && !e.retryable);

  const down = new Hashnode({ token: 't', publicationId: 'p', fetch: fakeFetch([['POST', () => new Response('x', { status: 503 })]], []) });
  await assert.rejects(down.metrics('x'), (e) => e instanceof ConnectorError && e.retryable);
});

test('Hashnode check names the account, and says why a token fails', async () => {
  const ok = new Hashnode({ token: 't', fetch: fakeFetch([['POST', gql({ me: { username: 'yeyo11' } })]], []) });
  assert.deepEqual(await ok.check(), { ok: true, account: 'yeyo11' });
  const bad = new Hashnode({ token: 't', fetch: fakeFetch([['POST', () => new Response('no', { status: 401 })]], []) });
  const result = await bad.check();
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.problem, /token was rejected/);
});

test('Telegram sends a message and links a public channel by its username', async () => {
  const calls: Call[] = [];
  const telegram = new Telegram({
    botToken: 'T',
    chatId: '@shipcast',
    fetch: fakeFetch([['POST https://api.telegram.org/botT/sendMessage', () => Response.json({ ok: true, result: { message_id: 7, chat: { id: -1001, username: 'shipcast' } } })]], calls),
  });
  assert.deepEqual(await telegram.publish({ text: 'hi', parseMode: 'HTML' }), { externalId: '@shipcast:7', url: 'https://t.me/shipcast/7' });
  assert.deepEqual(JSON.parse(String(calls[0]!.body)), { chat_id: '@shipcast', text: 'hi', parse_mode: 'HTML' });
});

test('Telegram sends a photo with caption and links a private chat by its internal id', async () => {
  const calls: Call[] = [];
  const telegram = new Telegram({
    botToken: 'T',
    chatId: -1001234,
    fetch: fakeFetch([['POST https://api.telegram.org/botT/sendPhoto', () => Response.json({ ok: true, result: { message_id: 9, chat: { id: -1001234 } } })]], calls),
  });
  assert.deepEqual(await telegram.publish({ text: 'cap', imageUrl: 'https://x.dev/i.jpg' }), { externalId: '-1001234:9', url: 'https://t.me/c/1234/9' });
  assert.deepEqual(JSON.parse(String(calls[0]!.body)), { chat_id: '-1001234', photo: 'https://x.dev/i.jpg', caption: 'cap' });
});

test('Telegram notify turns the link preview off; errors map to retryable or not', async () => {
  const calls: Call[] = [];
  const telegram = new Telegram({ botToken: 'T', chatId: '1', fetch: fakeFetch([['POST', () => Response.json({ ok: true, result: {} })]], calls) });
  await telegram.notify('review https://x.dev');
  assert.deepEqual(JSON.parse(String(calls[0]!.body)).link_preview_options, { is_disabled: true });
  assert.deepEqual(await telegram.metrics(), {});

  const rejected = new Telegram({ botToken: 'T', chatId: '1', fetch: fakeFetch([['POST', () => Response.json({ ok: false, description: 'Unauthorized' }, { status: 401 })]], []) });
  await assert.rejects(rejected.publish({ text: 'x' }), (e) => e instanceof ConnectorError && !e.retryable);
  const limited = new Telegram({ botToken: 'T', chatId: '1', fetch: fakeFetch([['POST', () => Response.json({ ok: false }, { status: 429 })]], []) });
  await assert.rejects(limited.publish({ text: 'x' }), (e) => e instanceof ConnectorError && e.retryable);
});

test('Telegram check reads the bot and the chat, and explains a rejected token', async () => {
  const ok = new Telegram({
    botToken: 'T',
    chatId: '@c',
    fetch: fakeFetch(
      [
        ['POST https://api.telegram.org/botT/getMe', () => Response.json({ ok: true, result: { username: 'shipcast_bot' } })],
        ['POST https://api.telegram.org/botT/getChat', () => Response.json({ ok: true, result: { title: 'Shipcast' } })],
      ],
      [],
    ),
  });
  assert.deepEqual(await ok.check(), { ok: true, account: '@shipcast_bot in Shipcast' });
  const bad = new Telegram({ botToken: 'T', chatId: '1', fetch: fakeFetch([['POST', () => Response.json({ ok: false }, { status: 401 })]], []) });
  const result = await bad.check();
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.problem, /token was rejected/);
});

const hook = 'https://discord.com/api/webhooks/1/abc';
const info = () => Response.json({ name: 'Shipcast', guild_id: 'G', channel_id: 'C' });

test('Discord posts with wait=true, an embed, and links the message through the guild', async () => {
  const calls: Call[] = [];
  const discord = new Discord({
    webhookUrl: hook,
    fetch: fakeFetch(
      [
        [`POST ${hook}?wait=true`, () => Response.json({ id: 'M', channel_id: 'C' })],
        [`GET ${hook}`, info],
      ],
      calls,
    ),
  });
  const published = await discord.publish({
    content: 'Released',
    embed: { title: 't', url: 'https://x.dev', description: 'd', imageUrl: 'https://x.dev/i.jpg' },
  });
  assert.deepEqual(published, { externalId: 'M', url: 'https://discord.com/channels/G/C/M' });
  assert.deepEqual(JSON.parse(String(calls[0]!.body)), {
    content: 'Released',
    embeds: [{ title: 't', url: 'https://x.dev', description: 'd', image: { url: 'https://x.dev/i.jpg' } }],
  });
  assert.deepEqual(await discord.metrics(), {});
});

test('Discord errors: 404 is final, 429 and 500 are retryable; check names the webhook', async () => {
  const gone = new Discord({ webhookUrl: hook, fetch: fakeFetch([['POST', () => new Response('{}', { status: 404 })]], []) });
  await assert.rejects(gone.publish({ content: 'x' }), (e) => e instanceof ConnectorError && !e.retryable);
  for (const status of [429, 500]) {
    const d = new Discord({ webhookUrl: hook, fetch: fakeFetch([['POST', () => new Response('{}', { status })]], []) });
    await assert.rejects(d.publish({ content: 'x' }), (e) => e instanceof ConnectorError && e.retryable);
  }
  assert.deepEqual(await new Discord({ webhookUrl: hook, fetch: fakeFetch([['GET', info]], []) }).check(), { ok: true, account: 'Shipcast' });
  const dead = await new Discord({ webhookUrl: hook, fetch: fakeFetch([['GET', () => new Response('{}', { status: 401 })]], []) }).check();
  assert.equal(dead.ok, false);
});
