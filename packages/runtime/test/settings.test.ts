import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryRegistry } from '@shipcast/engine/testing';
import { IMPORTED_KEY, importEnvSettings, InvalidSetting, MemoryStore, RuntimeSettings, SettingMissing } from '../src/index.ts';

const OLD_ENV = {
  SHIPCAST_LAUNCHES_REPO: 'yeyo11/launches',
  SHIPCAST_CLAUDIO_URL: 'http://localhost:8798/',
  SHIPCAST_CLAUDIO_TOKEN: 'claudio-token',
  SHIPCAST_MAX_BUDGET_USD: '5',
  INSTAGRAM_APP_ID: '42',
  INSTAGRAM_APP_SECRET: 'ig-secret',
};

test('with nothing set, each setting that is needed says so and where to set it', async () => {
  const settings = new RuntimeSettings({ registry: await memoryRegistry(), secrets: new MemoryStore(), env: {} });
  await settings.read();
  assert.deepEqual(settings.missing(), ['launchesRepo', 'claudioUrl', 'claudioToken']);
  assert.throws(() => settings.launchesRepo(), (e) => e instanceof SettingMissing && e.message === 'The launches repo is not set: set it in Settings (/settings)');
  assert.throws(() => settings.claudio(), SettingMissing);
});

test('.env is a fallback until a value is saved, and the source of each value is known', async () => {
  const registry = await memoryRegistry();
  const secrets = new MemoryStore();
  const settings = new RuntimeSettings({ registry, secrets, env: OLD_ENV });
  const values = await settings.read();
  assert.equal(values.launchesRepo, 'yeyo11/launches');
  assert.deepEqual(settings.claudio(), { url: 'http://localhost:8798', token: 'claudio-token' });
  assert.equal(values.maxBudgetUsd, 5);
  assert.equal(settings.sources().launchesRepo, '.env');

  await settings.write({ launchesRepo: 'yeyo11/other', claudioToken: 'fresh' });
  assert.equal(settings.current().launchesRepo, 'yeyo11/other');
  assert.equal(settings.sources().launchesRepo, 'settings');
  assert.equal(settings.sources().claudioToken, 'keychain');
  assert.equal(await secrets.get('app:claudio-token'), 'fresh', 'the token is in the keychain, not in the database');
  assert.equal(await registry.setting('claudio-token'), undefined);

  await settings.write({ launchesRepo: null });
  assert.equal(settings.current().launchesRepo, 'yeyo11/launches', 'cleared, .env shows again');
});

test('a value that does not pass its check is refused, and nothing of that save is kept', async () => {
  const settings = new RuntimeSettings({ registry: await memoryRegistry(), secrets: new MemoryStore(), env: {} });
  await assert.rejects(settings.write({ claudioUrl: 'http://claudio:8798', launchesRepo: 'launches' }), (e) => e instanceof InvalidSetting && /owner\/name/.test(e.message));
  await assert.rejects(settings.write({ maxBudgetUsd: '0' }), /positive number/);
  await assert.rejects(settings.write({ claudioUrl: 'claudio' }), /http\(s\)/);
  assert.equal((await settings.read()).claudioUrl, undefined);
  await settings.write({ maxBudgetUsd: '2.5' });
  assert.equal(settings.current().maxBudgetUsd, 2.5);
});

test('the one-time import copies what .env holds, once, and never undoes an edit or a clear made in the app', async () => {
  const registry = await memoryRegistry();
  const secrets = new MemoryStore();
  const deps = { registry, secrets, env: { ...OLD_ENV, SHIPCAST_LAUNCHES_REPO: 'not a repo' } };

  const first = await importEnvSettings(deps);
  assert.deepEqual(first.imported, ['SHIPCAST_CLAUDIO_URL', 'SHIPCAST_CLAUDIO_TOKEN', 'SHIPCAST_MAX_BUDGET_USD', 'INSTAGRAM_APP_ID', 'INSTAGRAM_APP_SECRET']);
  assert.deepEqual(first.skipped, ['SHIPCAST_LAUNCHES_REPO'], 'a value the Settings page would refuse stays in .env');
  assert.equal(await registry.setting('claudio-url'), 'http://localhost:8798/');
  assert.equal(await registry.setting('ai-budget-usd'), 5);
  assert.equal(await secrets.get('app:claudio-token'), 'claudio-token');
  assert.equal(await secrets.get('app:instagram-app-secret'), 'ig-secret');

  assert.deepEqual(await importEnvSettings(deps), { imported: [], skipped: ['SHIPCAST_LAUNCHES_REPO'] }, 'the second start imports nothing');

  const settings = new RuntimeSettings(deps);
  await settings.write({ claudioToken: 'edited', instagramAppId: null });
  await importEnvSettings(deps);
  assert.equal(await secrets.get('app:claudio-token'), 'edited', 'an edit is kept');
  assert.equal(await registry.setting('instagram-app-id'), '', 'a clear is kept');
  assert.ok(((await registry.setting<string[]>(IMPORTED_KEY)) ?? []).includes('INSTAGRAM_APP_ID'));

  // A value saved before the import ran is not replaced either
  const other = { registry: await memoryRegistry(), secrets: new MemoryStore(), env: OLD_ENV };
  await new RuntimeSettings(other).write({ launchesRepo: 'yeyo11/mine' });
  assert.ok(!(await importEnvSettings(other)).imported.includes('SHIPCAST_LAUNCHES_REPO'));
  assert.equal(await other.registry.setting('launches-repo'), 'yeyo11/mine');
});
