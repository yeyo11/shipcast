import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigError, loadConfig } from '../src/config.ts';

const complete = {
  GITHUB_TOKEN_PERSONAL: 'g',
  CLAUDIO_API_URL: 'http://localhost:8798',
  CLAUDIO_API_TOKEN: 'c',
  SHIPCAST_LAUNCHES_REPO: 'yeyo11/launches',
};

test('a complete environment gives the config, with the data and workspace under the working directory', () => {
  const config = loadConfig({ ...complete }, '/repo');
  assert.equal(config.launchesRepo, 'yeyo11/launches');
  assert.equal(config.dataDir, '/repo/data');
  assert.equal(config.workspaceHostDir, '/repo/workspace');
  assert.equal(config.workspaceProviderDir, '/workspace');
  assert.equal(config.maxBudgetUsd, undefined);
});

test('every missing variable is reported at once', () => {
  assert.throws(
    () => loadConfig({ CLAUDIO_API_URL: 'x' }, '/repo'),
    (e) => e instanceof ConfigError && e.message === 'missing in .env: GITHUB_TOKEN_PERSONAL, CLAUDIO_API_TOKEN, SHIPCAST_LAUNCHES_REPO (see .env.example)',
  );
});

test('a malformed launches repo or budget is refused', () => {
  assert.throws(() => loadConfig({ ...complete, SHIPCAST_LAUNCHES_REPO: 'launches' }, '/repo'), /owner\/name/);
  assert.throws(() => loadConfig({ ...complete, SHIPCAST_MAX_BUDGET_USD: '-1' }, '/repo'), /positive number/);
  assert.equal(loadConfig({ ...complete, SHIPCAST_MAX_BUDGET_USD: '5' }, '/repo').maxBudgetUsd, 5);
});
