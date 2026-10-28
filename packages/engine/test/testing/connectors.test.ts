import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConnectorError } from '@shipcast/connectors';
import { FakeConnectors } from '../../src/testing/connectors.ts';

test('publishers answer numbered pieces per channel and record their input; a failure can be for the next calls only', async () => {
  const fake = new FakeConnectors();
  const publishers = fake.publishers(['mastodon', 'bluesky', 'instagram']);
  assert.deepEqual(Object.keys(publishers).sort(), ['bluesky', 'instagram', 'mastodon']);
  fake.fail('mastodon', 'publish', new ConnectorError('Mastodon', 'publish: 503', 503), 1);
  await assert.rejects(publishers.mastodon!.publish({ text: 't', lang: 'en', idempotencyKey: 'k' }), /503/);
  assert.deepEqual(await publishers.mastodon!.publish({ text: 't', lang: 'en', idempotencyKey: 'k' }), { externalId: 'mastodon-1', url: 'https://mastodon.example/1' });
  assert.deepEqual(await publishers.bluesky!.publish({ text: 'b', lang: 'en' }), { externalId: 'bluesky-1', url: 'https://bluesky.example/1' });
  assert.deepEqual(await publishers.instagram!.comment!('ig-1', 'hi'), { id: 'instagram-comment-1' });
  assert.deepEqual(fake.log, ['mastodon publish', 'mastodon publish', 'bluesky publish', 'instagram comment ig-1']);
  assert.deepEqual(fake.callsOf('bluesky')[0]?.input, { text: 'b', lang: 'en' });
});

test('editors are built per channel and account, delete-only where the network cannot edit, none when unconnected', async () => {
  const fake = new FakeConnectors();
  const editors = fake.editors();
  await (await editors('mastodon', 4)).mastodon!.edit('m1', { text: 'x' });
  const bluesky = await editors('bluesky', null);
  assert.equal('edit' in bluesky.bluesky!, false);
  await bluesky.bluesky!.delete('b1');
  fake.unconnected.add('telegram');
  assert.deepEqual(await editors('telegram', null), {});
  assert.deepEqual(fake.calls, [
    { channel: 'mastodon', action: 'edit', id: 'm1', input: { text: 'x' }, accountId: 4 },
    { channel: 'bluesky', action: 'delete', id: 'b1', accountId: null },
  ]);
});

test('metric readers and comment connectors answer what the test holds for each post', async () => {
  const fake = new FakeConnectors();
  fake.metrics = { devto: { views: 3 }, bluesky: (id) => ({ likes: id.length }) };
  const readers = fake.metricReaders(['devto', 'bluesky']);
  assert.deepEqual(await readers.devto!.metrics('42'), { views: 3 });
  assert.deepEqual(await readers.bluesky!.metrics('abcd'), { likes: 4 });

  fake.threads['mastodon:100'] = [{ externalId: 'c1', author: { handle: '@a' }, text: 'hi', createdAt: '2026-11-03T09:00:00Z', own: false }];
  const mastodon = await fake.commentConnectors()('mastodon', 2);
  assert.equal((await mastodon.reader!.comments('100')).length, 1);
  const sent = await mastodon.replier!.reply({ postExternalId: '100', commentExternalId: 'c1', authorHandle: '@a' }, 'thanks', { key: 'k' });
  assert.equal(sent.externalId, 'mastodon-reply-1');
  assert.equal((await fake.commentConnectors()('devto', null)).replier, undefined, 'dev.to cannot reply');
  assert.deepEqual(fake.log, ['devto metrics 42', 'bluesky metrics abcd', 'mastodon comments 100', 'mastodon reply c1']);
});
