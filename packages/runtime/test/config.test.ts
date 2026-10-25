import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigError, loadAppConfig, loadConfig } from '../src/config.ts';

const complete = {
  GITHUB_TOKEN_PERSONAL: 'g',
  SHIPCAST_CLAUDIO_URL: 'http://localhost:8798',
  SHIPCAST_CLAUDIO_TOKEN: 'c',
  SHIPCAST_LAUNCHES_REPO: 'yeyo11/launches',
  SHIPCAST_DATABASE_URL: 'postgres://shipcast:shipcast@127.0.0.1:5433/shipcast',
};

test('a complete environment gives the config, with the data and workspace under the working directory', () => {
  const config = loadConfig({ ...complete }, '/repo');
  assert.equal(config.launchesRepo, 'yeyo11/launches');
  assert.equal(config.databaseUrl, 'postgres://shipcast:shipcast@127.0.0.1:5433/shipcast');
  assert.equal(config.dataDir, '/repo/data');
  assert.equal(config.workspaceHostDir, '/repo/workspace');
  assert.equal(config.workspaceProviderDir, '/workspace');
  assert.equal(config.maxBudgetUsd, undefined);
});

test('every missing variable is reported at once', () => {
  assert.throws(
    () => loadConfig({ SHIPCAST_CLAUDIO_URL: 'x' }, '/repo'),
    (e) => e instanceof ConfigError && e.message === 'missing in .env: GITHUB_TOKEN_PERSONAL, SHIPCAST_CLAUDIO_TOKEN, SHIPCAST_LAUNCHES_REPO, SHIPCAST_DATABASE_URL (see .env.example)',
  );
});

test('a malformed launches repo, budget or database URL is refused', () => {
  assert.throws(() => loadConfig({ ...complete, SHIPCAST_LAUNCHES_REPO: 'launches' }, '/repo'), /owner\/name/);
  assert.throws(() => loadConfig({ ...complete, SHIPCAST_MAX_BUDGET_USD: '-1' }, '/repo'), /positive number/);
  assert.throws(() => loadConfig({ ...complete, SHIPCAST_DATABASE_URL: 'data/shipcast.db' }, '/repo'), /postgres:\/\/ URL/);
  assert.equal(loadConfig({ ...complete, SHIPCAST_MAX_BUDGET_USD: '5' }, '/repo').maxBudgetUsd, 5);
});

test('the app config needs its address, the GitHub app and who may sign in', () => {
  assert.throws(() => loadAppConfig({}), /SHIPCAST_PUBLIC_URL, SHIPCAST_GITHUB_CLIENT_ID, SHIPCAST_GITHUB_CLIENT_SECRET, SHIPCAST_ALLOWED_GITHUB/);
  const app = loadAppConfig({
    SHIPCAST_PUBLIC_URL: 'https://shipcast.example.dev/',
    SHIPCAST_GITHUB_CLIENT_ID: 'id',
    SHIPCAST_GITHUB_CLIENT_SECRET: 'secret',
    SHIPCAST_ALLOWED_GITHUB: 'Yeyo11, other',
  });
  assert.equal(app.publicUrl, 'https://shipcast.example.dev');
  assert.deepEqual(app.allowedLogins, ['yeyo11', 'other']);
  assert.deepEqual([app.host, app.port, app.instagram, app.tlsCloudflareToken], ['127.0.0.1', 8744, undefined, undefined]);
  assert.throws(() => loadAppConfig({ SHIPCAST_PUBLIC_URL: 'http://x', SHIPCAST_GITHUB_CLIENT_ID: 'i', SHIPCAST_GITHUB_CLIENT_SECRET: 's', SHIPCAST_ALLOWED_GITHUB: 'a' }), /https:\/\/host/);
});
