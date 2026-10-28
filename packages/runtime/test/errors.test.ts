import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ShipcastError } from '@shipcast/schema';
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

test('the runtime errors are Shipcast errors: a retry later is retryable, the rest are not', () => {
  assert.deepEqual(
    [new SettingMissing('launchesRepo'), new RetryLater('x'), new ConfigError('y')].map((e) => [e instanceof ShipcastError, e.code, e.retryable, e.httpStatus]),
    [
      [true, 'setting_missing', false, 409],
      [true, 'retry_later', true, 503],
      [true, 'config', false, 500],
    ],
  );
});
