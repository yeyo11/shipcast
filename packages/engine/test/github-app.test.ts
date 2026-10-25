import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import { appJwt, GitHubApp, GitHubError, GitHubRest } from '../src/index.ts';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

interface Seen {
  method: string;
  url: string;
  authorization: string;
}

/** A fetch that answers by path, recording every request */
function fakeGitHub(routes: Record<string, () => Response>, seen: Seen[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    seen.push({ method, url, authorization: (init?.headers as Record<string, string>).authorization ?? '' });
    const route = routes[`${method} ${new URL(url).pathname}`];
    if (!route) throw new Error(`unexpected ${method} ${url}`);
    return route();
  }) as typeof fetch;
}

const NOW = Date.parse('2026-10-25T12:00:00Z');
let minted = 0;
const routes = (expiresInMs = 3600_000) => ({
  'GET /repos/yeyo11/launches/installation': () =>
    Response.json({ id: 77, account: { login: 'yeyo11' }, repository_selection: 'all', permissions: { contents: 'write', metadata: 'read' } }),
  'POST /app/installations/77/access_tokens': () => {
    minted++;
    return Response.json({ token: `ghs_${minted}`, expires_at: new Date(NOW + expiresInMs).toISOString() }, { status: 201 });
  },
});

test('the App signs a JWT with its key: RS256, issued a minute back, at most ten minutes', () => {
  const jwt = appJwt('Iv23client', pem, NOW);
  const [header, payload, signature] = jwt.split('.') as [string, string, string];
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url').toString()), { alg: 'RS256', typ: 'JWT' });
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { iat: number; exp: number; iss: string };
  assert.equal(claims.iss, 'Iv23client');
  assert.equal(claims.iat, NOW / 1000 - 60);
  assert.ok(claims.exp - claims.iat <= 600);
  assert.ok(createVerify('RSA-SHA256').update(`${header}.${payload}`).verify(publicKey, Buffer.from(signature, 'base64url')));
});

test('an installation token is minted once for the launches repo and reused until close to its expiry', async () => {
  minted = 0;
  const seen: Seen[] = [];
  let now = NOW;
  const app = new GitHubApp({ appId: '1', clientId: 'Iv23client', privateKey: pem, account: () => 'yeyo11/launches', fetch: fakeGitHub(routes(), seen), now: () => now });

  const [a, b] = await Promise.all([app.token(), app.token()]);
  assert.equal(a, 'ghs_1');
  assert.equal(b, 'ghs_1', 'two requests at once share one minting');
  assert.equal(await app.token(), 'ghs_1');
  assert.equal(minted, 1);
  assert.equal(seen.filter((s) => s.url.endsWith('/installation')).length, 1, 'the installation is looked up once');
  assert.ok(seen.every((s) => s.authorization.startsWith('Bearer ey')), 'the App authenticates with its JWT');

  now = NOW + 56 * 60_000;
  assert.equal(await app.token(), 'ghs_2', 'five minutes before expiry a new one is minted');
  assert.equal(seen.filter((s) => s.url.endsWith('/installation')).length, 1);

  app.refresh();
  assert.equal(await app.token(), 'ghs_3');
  assert.equal(seen.filter((s) => s.url.endsWith('/installation')).length, 2, 'refresh looks the installation up again');
  assert.deepEqual(await app.installation(), { id: 77, account: 'yeyo11', repositorySelection: 'all', permissions: { contents: 'write', metadata: 'read' } });
});

test('without a launches repo the owner’s own installation is used, and a missing one says how to fix it', async () => {
  const seen: Seen[] = [];
  const app = new GitHubApp({
    appId: '1',
    privateKey: pem,
    account: () => 'yeyo11',
    fetch: fakeGitHub({ 'GET /users/yeyo11/installation': () => Response.json({ message: 'Not Found' }, { status: 404 }) }, seen),
  });
  await assert.rejects(app.token(), (e: unknown) => e instanceof GitHubError && /not installed on yeyo11/.test(e.message));
  const none = new GitHubApp({ appId: '1', privateKey: pem, account: () => undefined, fetch: fakeGitHub({}, seen) });
  await assert.rejects(none.token(), /set the launches repo in Settings/);
});

test('the engine’s client sends the installation token, and mints a fresh one once when GitHub refuses it', async () => {
  minted = 0;
  const seen: Seen[] = [];
  let refusals = 1;
  const fetchImpl = fakeGitHub(
    {
      ...routes(),
      'GET /repos/yeyo11/shipcast/releases/latest': () => {
        if (refusals-- > 0) return Response.json({ message: 'Bad credentials' }, { status: 401 });
        return Response.json({ tag_name: 'v0.2.0', html_url: 'https://github.com/yeyo11/shipcast/releases/tag/v0.2.0' });
      },
    },
    seen,
  );
  const app = new GitHubApp({ appId: '1', privateKey: pem, account: () => 'yeyo11/launches', fetch: fetchImpl, now: () => NOW });
  const github = new GitHubRest({ token: app, fetch: fetchImpl });
  assert.deepEqual(await github.latestRelease('yeyo11/shipcast'), { tag: 'v0.2.0', url: 'https://github.com/yeyo11/shipcast/releases/tag/v0.2.0' });
  const calls = seen.filter((s) => s.url.includes('/releases/latest'));
  assert.deepEqual(
    calls.map((c) => c.authorization),
    ['Bearer ghs_1', 'Bearer ghs_2'],
  );
});

test('a personal token is sent as it is and a 401 is not retried', async () => {
  const seen: Seen[] = [];
  const github = new GitHubRest({
    token: 'ghp_x',
    fetch: fakeGitHub({ 'GET /repos/a/b/releases/latest': () => Response.json({}, { status: 401 }) }, seen),
  });
  await assert.rejects(github.latestRelease('a/b'), /401/);
  assert.deepEqual(seen.map((s) => s.authorization), ['Bearer ghp_x']);
});
