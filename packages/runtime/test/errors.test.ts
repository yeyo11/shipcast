import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigError, RetryLater, SettingMissing } from '../src/index.ts';

// Characterisation of the runtime's errors, pinned before they took the shared base

test('the runtime errors keep their messages and names', () => {
  const missing = new SettingMissing('launchesRepo');
  assert.ok(missing instanceof Error);
  assert.equal(missing.setting, 'launchesRepo');
  assert.match(missing.message, / is not set: set it in Settings \(\/settings\)$/);
  assert.equal(new SettingMissing('claudioUrl', 'The URL').message, 'The URL is not set: set it in Settings (/settings)');
  const later = new RetryLater('not live yet');
  assert.equal(later.name, 'RetryLater');
  assert.equal(later.message, 'not live yet');
  const config = new ConfigError('bad .env');
  assert.ok(config instanceof Error);
  assert.equal(config.message, 'bad .env');
});
