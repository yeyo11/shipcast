import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activeChannels, DEFAULT_MODES, formatIssues, parseLaunchConfig } from '../src/index.ts';

test('the plan example parses, with defaults filled in', () => {
  const result = parseLaunchConfig(`
enabled: true
brand: personal
language: en
content:
  article: true
  socialPosts: true
  technicalTutorial: true
publishing:
  blog: auto
  reddit: manual
`);
  assert.ok(result.ok, JSON.stringify(!result.ok && result.issues));
  const config = result.value;
  assert.equal(config.publishing.blog, 'auto');
  assert.equal(config.publishing.devto, DEFAULT_MODES.devto);
  assert.equal(config.publishing.x, 'off');
  assert.deepEqual(config.triggers, { release: true, manual: true, public: false, enabled: false });
  assert.deepEqual(config.reddit.subreddits, []);
});

test('the smallest file turns on the MVP channels', () => {
  const result = parseLaunchConfig('enabled: true\nbrand: personal\n');
  assert.ok(result.ok);
  assert.deepEqual(activeChannels(result.value), ['blog', 'devto', 'bluesky', 'mastodon', 'instagram', 'reddit']);
});

test('enabled must be written out', () => {
  const result = parseLaunchConfig('brand: personal\n');
  assert.ok(!result.ok);
  assert.equal(result.issues[0]?.path, 'enabled');
});

test('reddit and hackerNews refuse to be published automatically, pointing at the line', () => {
  const result = parseLaunchConfig(`enabled: true
brand: personal
publishing:
  blog: approval
  reddit: auto
`);
  assert.ok(!result.ok);
  const issue = result.issues.find((i) => i.path === 'publishing.reddit');
  assert.ok(issue, JSON.stringify(result.issues));
  assert.match(issue.message, /always a draft/);
  assert.equal(issue.line, 5);
});

test('a misspelt key is an error on its own line, not a setting silently ignored', () => {
  const result = parseLaunchConfig(`enabled: true
brand: personal
publishing:
  blgo: auto
`);
  assert.ok(!result.ok);
  assert.equal(result.issues[0]?.line, 4);
  assert.match(formatIssues('launch.yml', result.issues), /^launch\.yml:4:\d+ publishing: /);
});

test('broken YAML reports where it broke', () => {
  const result = parseLaunchConfig('enabled: true\nbrand: [personal\n');
  assert.ok(!result.ok);
  assert.ok(result.issues[0]?.line);
});

test('subreddits are names without r/', () => {
  const result = parseLaunchConfig('enabled: true\nbrand: personal\nreddit:\n  subreddits: [r/node]\n');
  assert.ok(!result.ok);
  assert.equal(result.issues[0]?.path, 'reddit.subreddits.0');
});
