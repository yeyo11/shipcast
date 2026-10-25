import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryStore } from '@shipcast/runtime';
import { InvalidInput, id, list, object, text, texts } from '../src/server/input.ts';
import { cookieOf, createSession, readSession, setCookie } from '../src/server/session.server.ts';

test('a session is signed: it reads back, and a changed or expired one does not', async () => {
  const secrets = new MemoryStore();
  const now = Date.parse('2026-10-25T00:00:00Z');
  const { value, maxAge } = await createSession(secrets, 'yeyo11', now);
  assert.equal(maxAge, 14 * 86_400);
  assert.equal((await readSession(secrets, value, now))?.login, 'yeyo11');

  const [payload, signature] = value.split('.');
  const forged = `${Buffer.from(JSON.stringify({ login: 'someone', expires: now + 1e9 })).toString('base64url')}.${signature}`;
  assert.equal(await readSession(secrets, forged, now), undefined, 'a different payload breaks the signature');
  assert.equal(await readSession(secrets, `${payload}.x`, now), undefined);
  assert.equal(await readSession(secrets, value, now + 15 * 86_400_000), undefined, 'expired');
  assert.equal(await readSession(new MemoryStore(), value, now), undefined, 'another key, another app');
});

test('a session carries the GitHub name and picture read at sign-in, signed with the login', async () => {
  const secrets = new MemoryStore();
  const now = Date.parse('2026-10-25T00:00:00Z');
  const { value } = await createSession(secrets, 'yeyo11', now, { name: 'José', avatarUrl: 'https://avatars.githubusercontent.com/u/1' });
  const session = await readSession(secrets, value, now);
  assert.deepEqual([session?.login, session?.name, session?.avatarUrl], ['yeyo11', 'José', 'https://avatars.githubusercontent.com/u/1']);
});

test('cookies are HttpOnly, Secure and Lax, and read back by name', () => {
  assert.equal(setCookie('sc_session', 'a b', 60), 'sc_session=a%20b; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=60');
  const request = new Request('https://x', { headers: { cookie: 'other=1; sc_session=a%20b' } });
  assert.equal(cookieOf(request, 'sc_session'), 'a b');
  assert.equal(cookieOf(request, 'missing'), undefined);
});

test('server function inputs are checked for shape', () => {
  assert.equal(id(3), 3);
  assert.throws(() => id('3'), InvalidInput);
  assert.throws(() => id(-1), InvalidInput);
  assert.throws(() => text(1, 'x'), InvalidInput);
  assert.throws(() => text('abc', 'x', 2), InvalidInput);
  assert.deepEqual(texts({ a: 'b' }, 'v'), { a: 'b' });
  assert.throws(() => texts({ a: 1 }, 'v'), InvalidInput);
  assert.throws(() => object([], 'o'), InvalidInput);
  assert.deepEqual(list(['a'], 'l'), ['a']);
});
