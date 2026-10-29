import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConnectorError, Discord, Hashnode, PostGone, Telegram } from '../src/index.ts';
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

test('Telegram reads the reaction changes it was pushed a page at a time, and confirms a page only once it is kept', async () => {
  const calls: Call[] = [];
  const change = (update_id: number, message_id: number, counts: number[], chat = { id: -1001234, username: 'shipcast' }) => ({
    update_id,
    message_reaction_count: { chat, message_id, date: 1, reactions: counts.map((total_count) => ({ type: { type: 'emoji', emoji: '🔥' }, total_count })) },
  });
  const pages = () =>
    sequence(
      // Another chat's post with the same id, and a later change of post 5 replacing the first
      () => Response.json({ ok: true, result: [change(10, 5, [1]), change(11, 6, [2, 1]), change(12, 5, [9], { id: -100999, username: 'other' }), change(13, 5, [3, 1])] }),
      () => Response.json({ ok: true, result: [change(14, 6, [5])] }),
      () => Response.json({ ok: true, result: [] }),
    );
  const telegram = new Telegram({ botToken: 'T', chatId: '@shipcast', fetch: fakeFetch([['POST https://api.telegram.org/botT/getUpdates', pages()]], calls) });
  const kept: Array<Array<[string, unknown]>> = [];
  const offsets = () => calls.map((c) => (JSON.parse(String(c.body)) as { offset?: number }).offset);
  await telegram.reactions(['@shipcast:5', '@shipcast:6', '@shipcast:7'], async (page) => {
    // Nothing read is confirmed before it is kept: the call that confirms a page comes after its store
    kept.push([...page]);
    assert.equal(offsets().length, kept.length, 'a page is kept before the next call confirms it');
  });
  assert.deepEqual(kept, [
    [
      ['@shipcast:5', { reactions: 4 }],
      ['@shipcast:6', { reactions: 3 }],
    ],
    [['@shipcast:6', { reactions: 5 }]],
  ]);
  assert.deepEqual(JSON.parse(String(calls[0]!.body)).allowed_updates, ['message_reaction_count'], 'only reaction counts, which Telegram leaves out unless asked');
  assert.deepEqual(offsets(), [undefined, 14, 15], 'each call confirms the page before it');

  // A page that cannot be kept is never confirmed: Telegram hands it again on the next read
  const failing: Call[] = [];
  const again = new Telegram({ botToken: 'T', chatId: '@shipcast', fetch: fakeFetch([['POST https://api.telegram.org/botT/getUpdates', pages()]], failing) });
  await assert.rejects(
    again.reactions(['@shipcast:5'], async () => {
      throw new Error('the database is down');
    }),
    /database/,
  );
  assert.equal(failing.length, 1, 'no call with an offset after a page that was not kept');

  const hooked = new Telegram({ botToken: 'T', chatId: '@shipcast', fetch: fakeFetch([['POST', () => Response.json({ ok: false, description: 'Conflict: can\'t use getUpdates method while webhook is active' }, { status: 409 })]], []) });
  await assert.rejects(hooked.reactions(['@shipcast:5'], async () => undefined), (e) => e instanceof ConnectorError && e.status === 409 && !e.retryable && /webhook/.test(e.message));
});

test('Telegram notify turns the link preview off; errors map to retryable or not', async () => {
  const calls: Call[] = [];
  const telegram = new Telegram({ botToken: 'T', chatId: '1', fetch: fakeFetch([['POST', () => Response.json({ ok: true, result: {} })]], calls) });
  await telegram.notify('review https://x.dev');
  assert.deepEqual(JSON.parse(String(calls[0]!.body)).link_preview_options, { is_disabled: true });

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
  assert.deepEqual(await ok.check(), { ok: true, account: '@shipcast_bot in Shipcast', displayName: 'Shipcast' });
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
});

test('Discord reads a message’s reactions back through the webhook; a deleted message is left out', async () => {
  const calls: Call[] = [];
  const discord = new Discord({
    webhookUrl: hook,
    fetch: fakeFetch(
      [
        [`GET ${hook}/messages/M`, () => Response.json({ id: 'M', reactions: [{ count: 3, emoji: { name: '🎉' } }, { count: 2, emoji: { name: '👀' } }] })],
        [`GET ${hook}/messages/N`, () => Response.json({ id: 'N' })],
        [`GET ${hook}/messages/X`, () => Response.json({ code: 10008, message: 'Unknown Message' }, { status: 404 })],
      ],
      calls,
    ),
  });
  assert.deepEqual(await discord.metrics('M'), { reactions: 5 });
  const many = await discord.metricsMany(['M', 'N', 'X']);
  assert.deepEqual([...many], [['M', { reactions: 5 }], ['N', { reactions: 0 }]]);
  await assert.rejects(discord.metrics('X'), (e) => e instanceof PostGone);
  assert.ok(calls.every((c) => c.method === 'GET'));
});

test('Discord counts the server’s members through its invite, from a code or a link', async () => {
  const calls: Call[] = [];
  const discord = new Discord({
    webhookUrl: hook,
    fetch: fakeFetch([['GET https://discord.com/api/v10/invites/sh1pcast?with_counts=true', () => Response.json({ code: 'sh1pcast', approximate_member_count: 41, approximate_presence_count: 7 })]], calls),
  });
  assert.deepEqual(await discord.profileStats('https://discord.gg/sh1pcast'), { followers: 41, extra: { online: 7 } });
  assert.deepEqual(await discord.profileStats('sh1pcast'), { followers: 41, extra: { online: 7 } });
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
