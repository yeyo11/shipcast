import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Bluesky, Brevo, ConnectorError, Devto, Discord, Hashnode, Instagram, Mastodon, Telegram } from '../src/index.ts';
import { fakeFetch, type Call } from './fake.ts';

const bodyOf = (call: Call | undefined) => JSON.parse(String(call?.body)) as Record<string, unknown>;

test('Mastodon edits a status in place, keeping its media and language when only the text changes', async () => {
  const calls: Call[] = [];
  const mastodon = new Mastodon({
    instance: 'https://mastodon.social/',
    accessToken: 't',
    fetch: fakeFetch(
      [
        ['GET https://mastodon.social/api/v1/statuses/111', () => Response.json({ id: '111', language: 'es', media_attachments: [{ id: 'm1' }] })],
        ['PUT https://mastodon.social/api/v1/statuses/111', () => Response.json({ id: '111' })],
      ],
      calls,
    ),
  });
  await mastodon.edit('111', { text: 'Fixed text' });
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.url}`),
    ['GET https://mastodon.social/api/v1/statuses/111', 'PUT https://mastodon.social/api/v1/statuses/111'],
  );
  assert.deepEqual(bodyOf(calls[1]), { status: 'Fixed text', media_ids: ['m1'], language: 'es' });
  assert.equal(calls[1]!.headers.authorization, 'Bearer t');
});

test('Mastodon swaps the image and keeps the source text when only the image changes', async () => {
  const calls: Call[] = [];
  const mastodon = new Mastodon({
    instance: 'https://mastodon.social',
    accessToken: 't',
    fetch: fakeFetch(
      [
        ['GET https://mastodon.social/api/v1/statuses/111/source', () => Response.json({ id: '111', text: 'Plain text https://x.dev' })],
        ['GET https://mastodon.social/api/v1/statuses/111', () => Response.json({ id: '111', language: null, media_attachments: [{ id: 'old' }] })],
        ['POST https://mastodon.social/api/v2/media', () => Response.json({ id: 'new' })],
        ['PUT https://mastodon.social/api/v1/statuses/111', () => Response.json({ id: '111' })],
      ],
      calls,
    ),
  });
  await mastodon.edit('111', { image: { bytes: new Uint8Array([1]), mimeType: 'image/png', filename: 'a.png', description: 'alt' } });
  assert.deepEqual(bodyOf(calls.at(-1)), { status: 'Plain text https://x.dev', media_ids: ['new'] });
});

test('Mastodon deletes a status', async () => {
  const calls: Call[] = [];
  const mastodon = new Mastodon({ instance: 'https://mastodon.social', accessToken: 't', fetch: fakeFetch([['DELETE https://mastodon.social/api/v1/statuses/111', () => Response.json({})]], calls) });
  await mastodon.delete('111');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.headers.authorization, 'Bearer t');
});

const telegramAnswer = (result: unknown) => () => Response.json({ ok: true, result });
const telegramError = (description: string) => () => Response.json({ ok: false, error_code: 400, description }, { status: 400 });

test('Telegram edits a text message by its chat and message id', async () => {
  const calls: Call[] = [];
  const telegram = new Telegram({ botToken: 'B', chatId: '@x', fetch: fakeFetch([['POST https://api.telegram.org/botB/editMessageText', telegramAnswer({ message_id: 7 })]], calls) });
  await telegram.edit('-100123:7', { text: 'New' });
  assert.deepEqual(bodyOf(calls[0]), { chat_id: '-100123', message_id: 7, text: 'New' });
});

test('Telegram edits the caption when the message is a photo, and an unchanged text is not a failure', async () => {
  const calls: Call[] = [];
  const telegram = new Telegram({
    botToken: 'B',
    chatId: '@x',
    fetch: fakeFetch(
      [
        ['POST https://api.telegram.org/botB/editMessageText', telegramError('Bad Request: there is no text in the message to edit')],
        ['POST https://api.telegram.org/botB/editMessageCaption', telegramError('Bad Request: message is not modified: specified new message content and reply markup are exactly the same')],
      ],
      calls,
    ),
  });
  await telegram.edit('@shipcast:9', { text: 'Caption' });
  assert.deepEqual(bodyOf(calls[1]), { chat_id: '@shipcast', message_id: 9, caption: 'Caption' });
});

test('Telegram replaces a photo with its caption, and deletes a message', async () => {
  const calls: Call[] = [];
  const telegram = new Telegram({
    botToken: 'B',
    chatId: '@x',
    fetch: fakeFetch(
      [
        ['POST https://api.telegram.org/botB/editMessageMedia', telegramAnswer({ message_id: 9 })],
        ['POST https://api.telegram.org/botB/deleteMessage', telegramAnswer(true)],
      ],
      calls,
    ),
  });
  await telegram.edit('-1009:9', { text: 'Caption', imageUrl: 'https://site.dev/og.jpg' });
  assert.deepEqual(bodyOf(calls[0]), { chat_id: '-1009', message_id: 9, media: { type: 'photo', media: 'https://site.dev/og.jpg', caption: 'Caption' } });
  await telegram.delete('-1009:9');
  assert.deepEqual(bodyOf(calls[1]), { chat_id: '-1009', message_id: 9 });
});

test('Telegram refuses an id that is not <chat>:<message>, and passes on other refusals', async () => {
  const telegram = new Telegram({ botToken: 'B', chatId: '@x', fetch: fakeFetch([['POST', telegramError("Bad Request: message can't be deleted for everyone")]], []) });
  await assert.rejects(telegram.delete('12'), (e) => e instanceof ConnectorError && /not a <chat>:<message>/.test(e.message));
  await assert.rejects(telegram.delete('@x:1'), (e) => e instanceof ConnectorError && e.status === 400 && /can't be deleted/.test(e.message));
});

test('Discord edits and deletes the webhook message with the webhook id and token from its URL', async () => {
  const calls: Call[] = [];
  const hook = 'https://discord.com/api/webhooks/123/tok';
  const discord = new Discord({
    webhookUrl: hook,
    fetch: fakeFetch(
      [
        [`PATCH ${hook}/messages/555`, () => Response.json({ id: '555' })],
        [`DELETE ${hook}/messages/555`, () => new Response(null, { status: 204 })],
      ],
      calls,
    ),
  });
  await discord.edit('555', { content: 'New text' });
  assert.deepEqual(bodyOf(calls[0]), { content: 'New text' }, 'without a card the message keeps its own');
  await discord.edit('555', { content: 'C', embed: { title: 'T', url: 'https://x.dev', description: 'D', imageUrl: 'https://x.dev/i.png' } });
  assert.deepEqual(bodyOf(calls[1]), { content: 'C', embeds: [{ title: 'T', url: 'https://x.dev', description: 'D', image: { url: 'https://x.dev/i.png' } }] });
  await discord.delete('555');
  assert.equal(calls[2]!.method, 'DELETE');
});

test('Discord keeps a thread id the webhook URL carries', async () => {
  const calls: Call[] = [];
  const discord = new Discord({ webhookUrl: 'https://discord.com/api/webhooks/1/t?thread_id=9', fetch: fakeFetch([['DELETE', () => new Response(null, { status: 204 })]], calls) });
  await discord.delete('5');
  assert.equal(calls[0]!.url, 'https://discord.com/api/webhooks/1/t/messages/5?thread_id=9');
});

test('dev.to edits only what is given, and "deletes" by unpublishing', async () => {
  const calls: Call[] = [];
  const devto = new Devto({ apiKey: 'k', fetch: fakeFetch([['PUT https://dev.to/api/articles/42', () => Response.json({ id: 42 })]], calls) });
  await devto.edit('42', { markdown: 'New body', canonicalUrl: 'https://site.dev/en/x/' });
  assert.deepEqual(bodyOf(calls[0]), { article: { body_markdown: 'New body', canonical_url: 'https://site.dev/en/x/' } });
  await devto.delete('42');
  assert.deepEqual(bodyOf(calls[1]), { article: { published: false } });
  assert.equal(calls[1]!.headers['api-key'], 'k');
});

test('Hashnode edits with updatePost and deletes with removePost', async () => {
  const calls: Call[] = [];
  const hashnode = new Hashnode({
    token: 'h',
    publicationId: 'p',
    fetch: fakeFetch(
      [
        [
          'POST https://gql.hashnode.com',
          () => Response.json({ data: { updatePost: { post: { id: 'a1' } }, removePost: { post: { id: 'a1' } } } }),
        ],
      ],
      calls,
    ),
  });
  await hashnode.edit('a1', { title: 'T', markdown: 'B', tags: ['Open Source'] });
  const edit = bodyOf(calls[0]) as { query: string; variables: unknown };
  assert.match(edit.query, /updatePost\(input: \$input\)/);
  assert.deepEqual(edit.variables, { input: { id: 'a1', title: 'T', contentMarkdown: 'B', tags: [{ slug: 'open-source', name: 'Open Source' }] } });
  await hashnode.delete('a1');
  const removal = bodyOf(calls[1]) as { query: string; variables: unknown };
  assert.match(removal.query, /removePost\(input: \$input\)/);
  assert.deepEqual(removal.variables, { input: { id: 'a1' } });
});

test('Bluesky deletes the record named by the at:// URI', async () => {
  const calls: Call[] = [];
  const bluesky = new Bluesky({
    identifier: 'me.bsky.social',
    appPassword: 'pw',
    fetch: fakeFetch(
      [
        ['POST https://bsky.social/xrpc/com.atproto.server.createSession', () => Response.json({ did: 'did:plc:abc', handle: 'me.bsky.social', accessJwt: 'jwt' })],
        ['POST https://bsky.social/xrpc/com.atproto.repo.deleteRecord', () => Response.json({ commit: { cid: 'c', rev: 'r' } })],
      ],
      calls,
    ),
  });
  await bluesky.delete('at://did:plc:abc/app.bsky.feed.post/3kxyz');
  assert.deepEqual(bodyOf(calls[1]), { repo: 'did:plc:abc', collection: 'app.bsky.feed.post', rkey: '3kxyz' });
  assert.equal(calls[1]!.headers.authorization, 'Bearer jwt');
  await assert.rejects(bluesky.delete('3kxyz'), /not an at:\/\/ record URI/);
});

test('Bluesky, Instagram and Brevo have no edit; Instagram and Brevo have no delete', () => {
  const bluesky = new Bluesky({ identifier: 'x', appPassword: 'y' }) as object;
  const instagram = new Instagram({ userId: '1', accessToken: 't' }) as object;
  const brevo = new Brevo({ apiKey: 'k' }) as object;
  assert.equal('edit' in bluesky, false);
  assert.equal('edit' in instagram || 'delete' in instagram, false);
  assert.equal('edit' in brevo || 'delete' in brevo, false);
});
