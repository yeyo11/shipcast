import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inferPack, LaunchConfig, parseVersion, resolvePack } from '../src/index.ts';

test('parseVersion reads semver tags with or without v', () => {
  assert.deepEqual(parseVersion('v1.2.3'), { major: 1, minor: 2, patch: 3 });
  assert.deepEqual(parseVersion('0.8.1-beta.2'), { major: 0, minor: 8, patch: 1 });
  assert.equal(parseVersion('nightly'), null);
});

test('the first launch of a project is a launch', () => {
  assert.equal(inferPack('v0.8.1', undefined), 'launch');
});

test('a new major is major; before 1.0 a minor bump is', () => {
  assert.equal(inferPack('v2.0.0', 'v1.9.4'), 'major');
  assert.equal(inferPack('v0.9.0', 'v0.8.1'), 'major');
  assert.equal(inferPack('v1.3.0', 'v1.2.0'), 'minor');
  assert.equal(inferPack('v0.8.1', 'v0.8.0'), 'minor');
});

test('a tag that is not semver gets the quiet pack', () => {
  assert.equal(inferPack('nightly', 'v1.0.0'), 'minor');
});

test("launch.yml's pack wins over the inference", () => {
  const config = LaunchConfig.parse({ enabled: true, brand: 'personal', pack: 'launch' });
  assert.equal(resolvePack(config, 'v1.3.0', 'v1.2.0'), 'launch');
});
