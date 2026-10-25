import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigError, loadAppConfig, loadConfig } from '../src/config.ts';

const PEM = '-----BEGIN PRIVATE KEY-----\nMII\n-----END PRIVATE KEY-----\n';
const DATABASE = { SHIPCAST_DATABASE_URL: 'postgres://shipcast:shipcast@127.0.0.1:5433/shipcast' };
const APP = {
  SHIPCAST_GITHUB_APP_ID: '123',
  SHIPCAST_GITHUB_APP_SLUG: 'shipcast-test',
  SHIPCAST_GITHUB_APP_CLIENT_ID: 'Iv23app',
  SHIPCAST_GITHUB_APP_CLIENT_SECRET: 'app-secret',
  SHIPCAST_GITHUB_APP_WEBHOOK_SECRET: 'hook',
  SHIPCAST_GITHUB_APP_PRIVATE_KEY_FILE: 'data/github-app.pem',
};
const files = (path: string) => {
  if (path === '/repo/data/github-app.pem') return PEM;
  throw new Error('ENOENT');
};

test('the bootstrap is the database and the GitHub App: nothing else is needed to start', () => {
  const config = loadConfig({ ...DATABASE, ...APP, SHIPCAST_ALLOWED_GITHUB: 'Yeyo11' }, '/repo', files);
  assert.equal(config.databaseUrl, DATABASE.SHIPCAST_DATABASE_URL);
  assert.equal(config.dataDir, '/repo/data');
  assert.equal(config.workspaceHostDir, '/repo/workspace');
  assert.equal(config.workspaceProviderDir, '/workspace');
  assert.equal(config.keychainService, 'shipcast');
  assert.deepEqual(config.githubApp, { appId: '123', slug: 'shipcast-test', clientId: 'Iv23app', clientSecret: 'app-secret', webhookSecret: 'hook', privateKey: PEM });
  assert.equal(config.githubToken, undefined);
  assert.deepEqual(config.allowedLogins, ['yeyo11']);
  assert.equal(loadConfig({ ...DATABASE, SHIPCAST_GITHUB_APP_ID: '1', SHIPCAST_GITHUB_APP_CLIENT_ID: 'c', SHIPCAST_GITHUB_APP_CLIENT_SECRET: 's', SHIPCAST_GITHUB_APP_PRIVATE_KEY: PEM.replace(/\n/g, '\\n') }, '/repo').githubApp?.privateKey, PEM, 'an inline key with escaped newlines');
});

test('settings are not the bootstrap: the launches repo, claudio and the budget are never required', () => {
  assert.doesNotThrow(() => loadConfig({ ...DATABASE, ...APP }, '/repo', files));
  // Old values in .env are not validated here either: they are imported (or skipped) as settings
  assert.doesNotThrow(() => loadConfig({ ...DATABASE, ...APP, SHIPCAST_LAUNCHES_REPO: 'nonsense', SHIPCAST_MAX_BUDGET_USD: '-1' }, '/repo', files));
});

test('without an App the old token is the fallback; with neither, the start says what to set', () => {
  const config = loadConfig({ ...DATABASE, GITHUB_TOKEN_PERSONAL: 'ghp' }, '/repo');
  assert.equal(config.githubApp, undefined);
  assert.equal(config.githubToken, 'ghp');
  assert.throws(() => loadConfig({ ...DATABASE }, '/repo'), (e) => e instanceof ConfigError && /GitHub App .* GITHUB_TOKEN_PERSONAL/.test(e.message));
  assert.throws(() => loadConfig({ ...APP }, '/repo', files), /SHIPCAST_DATABASE_URL/);
  assert.throws(() => loadConfig({ SHIPCAST_DATABASE_URL: 'data/shipcast.db', ...APP }, '/repo', files), /postgres:\/\/ URL/);
});

test('half an App stops the start instead of falling back in silence', () => {
  assert.throws(() => loadConfig({ ...DATABASE, GITHUB_TOKEN_PERSONAL: 'ghp', SHIPCAST_GITHUB_APP_ID: '1' }, '/repo'), /half set .*SHIPCAST_GITHUB_APP_CLIENT_ID.*PRIVATE_KEY_FILE/);
  assert.throws(() => loadConfig({ ...DATABASE, ...APP, SHIPCAST_GITHUB_APP_PRIVATE_KEY_FILE: 'gone.pem' }, '/repo', files), /cannot read gone\.pem/);
  assert.throws(() => loadConfig({ ...DATABASE, ...APP }, '/repo', () => 'not a key'), /not a PEM private key/);
});

test('the app signs in through the GitHub App, or the old OAuth App while there is none', () => {
  assert.throws(() => loadAppConfig({}), /SHIPCAST_GITHUB_APP_CLIENT_ID, SHIPCAST_GITHUB_APP_CLIENT_SECRET, SHIPCAST_PUBLIC_URL, SHIPCAST_ALLOWED_GITHUB/);
  const base = { SHIPCAST_PUBLIC_URL: 'https://shipcast.example.dev/', SHIPCAST_ALLOWED_GITHUB: 'Yeyo11, other' };
  const app = loadAppConfig({ ...base, ...APP, SHIPCAST_GITHUB_CLIENT_ID: 'old', SHIPCAST_GITHUB_CLIENT_SECRET: 'old-secret' });
  assert.deepEqual(app.github, { clientId: 'Iv23app', clientSecret: 'app-secret', kind: 'app' }, 'the App wins over the old OAuth App');
  assert.equal(app.publicUrl, 'https://shipcast.example.dev');
  assert.deepEqual(app.allowedLogins, ['yeyo11', 'other']);
  assert.deepEqual([app.host, app.port, app.tlsCloudflareToken], ['127.0.0.1', 8744, undefined]);
  const old = loadAppConfig({ ...base, SHIPCAST_GITHUB_CLIENT_ID: 'old', SHIPCAST_GITHUB_CLIENT_SECRET: 'old-secret' });
  assert.deepEqual(old.github, { clientId: 'old', clientSecret: 'old-secret', kind: 'oauth-app' });
  assert.throws(() => loadAppConfig({ ...base, SHIPCAST_GITHUB_CLIENT_ID: 'old' }), /SHIPCAST_GITHUB_CLIENT_SECRET/);
  assert.throws(() => loadAppConfig({ ...APP, SHIPCAST_PUBLIC_URL: 'http://x', SHIPCAST_ALLOWED_GITHUB: 'a' }), /https:\/\/host/);
});
