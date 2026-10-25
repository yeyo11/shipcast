import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exchangeCode, GITHUB_USER_KEY, GitHubSignInError, GitHubUserTokens, MemoryStore } from '../src/index.ts';

const NOW = Date.parse('2026-10-25T12:00:00Z');

/** GitHub's token endpoint: answers each request with the next answer, recording the bodies */
function tokenEndpoint(answers: object[], bodies: Array<Record<string, string>>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(input), 'https://github.com/login/oauth/access_token');
    bodies.push(JSON.parse(String(init?.body)) as Record<string, string>);
    const next = answers.shift();
    if (!next) throw new Error('unexpected request');
    return Response.json(next);
  }) as typeof fetch;
}

const pair = (n: number) => ({ access_token: `ghu_${n}`, expires_in: 28800, refresh_token: `ghr_${n}`, refresh_token_expires_in: 15897600 });

test('the sign-in code becomes the user token and its refresh token', async () => {
  const bodies: Array<Record<string, string>> = [];
  const client = { clientId: 'Iv23app', clientSecret: 's', fetch: tokenEndpoint([pair(1), { error: 'bad_verification_code', error_description: 'The code is wrong' }], bodies) };
  assert.equal((await exchangeCode(client, 'code', 'https://x/auth/github/callback')).refresh_token, 'ghr_1');
  assert.deepEqual(bodies[0], { client_id: 'Iv23app', client_secret: 's', code: 'code', redirect_uri: 'https://x/auth/github/callback' });
  await assert.rejects(exchangeCode(client, 'old', 'https://x'), (e) => e instanceof GitHubSignInError && e.message === 'The code is wrong');
});

test('the user token is kept in the keychain and refreshed on its own close to its expiry', async () => {
  const bodies: Array<Record<string, string>> = [];
  const secrets = new MemoryStore();
  let now = NOW;
  const tokens = new GitHubUserTokens({ secrets, client: { clientId: 'Iv23app', clientSecret: 's', fetch: tokenEndpoint([pair(2)], bodies) }, now: () => now });

  const saved = await tokens.save('yeyo11', pair(1));
  assert.deepEqual(saved, {
    login: 'yeyo11',
    accessToken: 'ghu_1',
    expiresAt: '2026-10-25T20:00:00.000Z',
    refreshToken: 'ghr_1',
    refreshExpiresAt: '2027-04-27T12:00:00.000Z',
  });
  assert.ok((await secrets.get(GITHUB_USER_KEY))?.includes('ghr_1'));

  now = NOW + 7 * 3600_000;
  assert.equal(await tokens.token(), 'ghu_1', 'an hour left: used as it is');
  assert.equal(bodies.length, 0);

  now = NOW + 8 * 3600_000 - 60_000;
  const [a, b] = await Promise.all([tokens.token(), tokens.token()]);
  assert.deepEqual([a, b], ['ghu_2', 'ghu_2'], 'one refresh for two callers: the refresh token can be spent once');
  assert.deepEqual(bodies, [{ client_id: 'Iv23app', client_secret: 's', grant_type: 'refresh_token', refresh_token: 'ghr_1' }]);
  assert.equal((await tokens.stored())?.refreshToken, 'ghr_2', 'the new pair is saved at once');
});

test('a refresh token that expired or was refused means signing in again, not an error in the background', async () => {
  const secrets = new MemoryStore();
  let now = NOW;
  const refused = new GitHubUserTokens({ secrets, client: { clientId: 'c', clientSecret: 's', fetch: tokenEndpoint([{ error: 'bad_refresh_token' }], []) }, now: () => now });
  await refused.save('yeyo11', pair(1));
  now = NOW + 9 * 3600_000;
  assert.equal(await refused.token(), undefined);
  assert.equal(await secrets.get(GITHUB_USER_KEY), undefined);

  now = NOW;
  const expired = new GitHubUserTokens({ secrets, client: { clientId: 'c', clientSecret: 's', fetch: tokenEndpoint([], []) }, now: () => now });
  await expired.save('yeyo11', pair(1));
  now = NOW + 200 * 86_400_000;
  assert.equal(await expired.token(), undefined, 'no request is made with a dead refresh token');

  const forever = new GitHubUserTokens({ secrets, client: { clientId: 'c', clientSecret: 's', fetch: tokenEndpoint([], []) } });
  await forever.save('yeyo11', { access_token: 'ghu_x' });
  assert.equal(await forever.token(), 'ghu_x', 'an App without expiring tokens gives one that is never refreshed');
});
