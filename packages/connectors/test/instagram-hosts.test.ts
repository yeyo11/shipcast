import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConnectorError, Instagram } from '../src/index.ts';
import { fakeFetch, type Call } from './fake.ts';

const ID = '17841416971174401';

test('on graph.facebook.com the account is read by its id, not /me', async () => {
  const calls: Call[] = [];
  const ig = new Instagram({
    host: 'facebook',
    userId: ID,
    accessToken: 't',
    fetch: fakeFetch([[`GET https://graph.facebook.com/v27.0/${ID}`, () => Response.json({ id: ID, username: 'me', name: 'Me' })]], calls),
  });
  assert.deepEqual(await ig.check(), { ok: true, account: '@me', displayName: 'Me' });
  assert.equal(calls.some((c) => c.url.includes('/me?') || c.url.includes('/me/')), false);
  assert.match(calls[0]!.url, /fields=id%2Cusername%2Cname%2Cprofile_picture_url/);
});

test('a token for another account is refused on graph.facebook.com too', async () => {
  const ig = new Instagram({
    host: 'facebook',
    userId: ID,
    accessToken: 't',
    fetch: fakeFetch([[`GET https://graph.facebook.com/v27.0/${ID}`, () => Response.json({ id: '17841400000000001', username: 'other' })]], []),
  });
  const result = await ig.check();
  assert.equal(result.ok, false);
  assert.match((result as { problem: string }).problem, /@other/);
});

test('profile and profileStats read /{id} on graph.facebook.com', async () => {
  const calls: Call[] = [];
  const ig = new Instagram({
    host: 'facebook',
    userId: ID,
    accessToken: 't',
    fetch: fakeFetch(
      [
        [`GET https://graph.facebook.com/v27.0/${ID}/insights`, () => Response.json({ data: [] })],
        [`GET https://graph.facebook.com/v27.0/${ID}?fields=name`, () => Response.json({ name: 'Me', biography: 'bio', website: 'https://example.com' })],
        [`GET https://graph.facebook.com/v27.0/${ID}?fields=followers_count`, () => Response.json({ followers_count: 5, follows_count: 2, media_count: 3 })],
      ],
      calls,
    ),
  });
  const profile = await ig.profile();
  assert.equal(profile.bio, 'bio');
  await ig.profileStats();
  assert.equal(calls.some((c) => c.url.includes('/me?')), false);
  assert.ok(calls.some((c) => decodeURIComponent(c.url).includes('fields=name,biography,website,profile_picture_url')));
  assert.ok(calls.some((c) => decodeURIComponent(c.url).includes('fields=followers_count,follows_count,media_count')));
});

test('refreshToken on graph.facebook.com throws without a network call', async () => {
  const calls: Call[] = [];
  const ig = new Instagram({ host: 'facebook', userId: ID, accessToken: 't', fetch: fakeFetch([], calls) });
  await assert.rejects(ig.refreshToken(), (e: unknown) => e instanceof ConnectorError && /connect Instagram again/.test(e.message));
  assert.equal(calls.length, 0);
});

test('graph.instagram.com is unchanged: /me and v25.0', async () => {
  const calls: Call[] = [];
  const ig = new Instagram({
    userId: ID,
    accessToken: 't',
    fetch: fakeFetch([['GET https://graph.instagram.com/v25.0/me', () => Response.json({ user_id: ID, id: 'x', username: 'me' })]], calls),
  });
  assert.equal((await ig.check()).ok, true);
  assert.match(calls[0]!.url, /^https:\/\/graph\.instagram\.com\/v25\.0\/me\?/);
});

/** A cache shared by connectors, as Redis or the process's memory is between accounts */
function sharedCache() {
  const kept = new Map<string, string>();
  return {
    kept,
    async remember<T extends string>(key: string, _ttl: number, load: () => Promise<T>): Promise<T> {
      const seen = kept.get(key) as T | undefined;
      if (seen !== undefined) return seen;
      const value = await load();
      kept.set(key, value);
      return value;
    },
    async delete(key: string) {
      kept.delete(key);
    },
  };
}

test("two Unified Login accounts sharing one token each know their own username, not the first's", async () => {
  const OTHER = '17841400000000002';
  const cache = sharedCache();
  const comments = (id: string, mine: string) => () =>
    Response.json({ data: [{ id: `c-${id}`, text: 'Gracias', timestamp: '2026-10-22T09:00:00+0000', username: mine }, { id: `d-${id}`, text: 'Hi', timestamp: '2026-10-22T09:00:00+0000', username: 'ana' }] });
  const http = fakeFetch(
    [
      [`GET https://graph.facebook.com/v27.0/${ID}?`, () => Response.json({ username: 'first' })],
      [`GET https://graph.facebook.com/v27.0/${OTHER}?`, () => Response.json({ username: 'second' })],
      ['GET https://graph.facebook.com/v27.0/111/comments', comments('111', 'first')],
      ['GET https://graph.facebook.com/v27.0/222/comments', comments('222', 'second')],
    ],
    [],
  );
  const first = new Instagram({ host: 'facebook', userId: ID, accessToken: 'one-token', fetch: http, cache });
  const second = new Instagram({ host: 'facebook', userId: OTHER, accessToken: 'one-token', fetch: http, cache });
  assert.deepEqual((await first.comments('111')).map((c) => [c.author.handle, c.own]), [['@first', true], ['@ana', false]]);
  assert.deepEqual((await second.comments('222')).map((c) => [c.author.handle, c.own]), [['@second', true], ['@ana', false]], "the second account's own reply is its own");
  assert.equal(cache.kept.size, 2, 'one username kept per account');
});

test('a comments refusal on graph.facebook.com names the permission its login grants', async () => {
  const refusal = () => Response.json({ error: { message: '(#10) Application does not have permission for this action', type: 'OAuthException', code: 10 } }, { status: 403 });
  const ig = new Instagram({
    host: 'facebook',
    userId: ID,
    accessToken: 't',
    fetch: fakeFetch(
      [
        [`GET https://graph.facebook.com/v27.0/${ID}?`, () => Response.json({ username: 'me' })],
        ['GET https://graph.facebook.com/v27.0/555/comments', refusal],
      ],
      [],
    ),
  });
  await assert.rejects(
    ig.comments('555'),
    (e: unknown) => e instanceof ConnectorError && /without instagram_manage_comments/.test(e.message) && !/business/.test(e.message) && !e.retryable,
  );
});
