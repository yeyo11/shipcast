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
