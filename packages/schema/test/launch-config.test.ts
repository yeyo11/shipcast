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
  assert.deepEqual(activeChannels(result.value), ['blog', 'devto', 'bluesky', 'mastodon', 'instagram'], 'Reddit only when a launch.yml asks for it');
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

test('assets.site alone is valid, and a tour and screenshot pages are read', () => {
  const alone = parseLaunchConfig('enabled: true\nbrand: personal\nassets:\n  site: https://claudio.example\n');
  assert.ok(alone.ok);
  assert.equal(alone.value.assets.demo, undefined);
  const full = parseLaunchConfig(`enabled: true
brand: personal
assets:
  site: https://claudio.example
  tour:
    - wait: 1000
    - scroll: 600
    - scroll: bottom
    - click: "#start"
    - goto: /docs
  screenshots:
    - path: /
    - path: /docs/start
      name: start
`);
  assert.ok(full.ok, JSON.stringify(!full.ok && full.issues));
  assert.equal(full.value.assets.tour?.length, 5);
  assert.deepEqual(full.value.assets.screenshots?.[1], { path: '/docs/start', name: 'start' });
});

test('an invalid tour step, site or page is an error with its line', () => {
  const bad = (assets: string) => parseLaunchConfig(`enabled: true\nbrand: personal\nassets:\n${assets}`);
  assert.ok(!bad('  site: http://claudio.example\n').ok, 'https only');
  assert.ok(!bad('  tour:\n    - jump: 3\n').ok, 'unknown step');
  assert.ok(!bad('  tour:\n    - scroll: 10\n      wait: 100\n').ok, 'one action per step');
  assert.ok(!bad('  tour:\n    - scroll: middle\n').ok);
  assert.ok(!bad('  tour:\n    - goto: https://elsewhere.example\n').ok, 'a path on the same site');
  assert.ok(!bad('  tour:\n    - goto: //elsewhere.example\n').ok);
  assert.ok(!bad('  tour:\n    - wait: 999999\n').ok);
  assert.ok(!bad(`  tour:\n${'    - wait: 100\n'.repeat(13)}`).ok, 'at most 12 steps');
  assert.ok(!bad('  screenshots:\n    - path: docs\n').ok);
  assert.ok(!bad('  screenshots:\n    - path: /\n      title: x\n').ok, 'strict');
  const result = bad('  tour:\n    - click: ""\n');
  assert.ok(!result.ok);
  assert.match(formatIssues('launch.yml', result.issues), /launch\.yml:\d+/);
});
