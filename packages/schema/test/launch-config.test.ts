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
  reddit: approval
`);
  assert.ok(result.ok, JSON.stringify(!result.ok && result.issues));
  const config = result.value;
  assert.equal(config.publishing.blog, 'auto');
  assert.equal(config.publishing.devto, DEFAULT_MODES.devto);
  assert.equal(config.publishing.reddit, 'approval');
  assert.deepEqual(config.triggers, { release: true, manual: true, public: false, enabled: false });
  assert.deepEqual(config.reddit.subreddits, []);
});

test('the smallest file turns on the MVP channels and GitHub Discussions', () => {
  const result = parseLaunchConfig('enabled: true\nbrand: personal\n');
  assert.ok(result.ok);
  assert.deepEqual(activeChannels(result.value), ['blog', 'devto', 'bluesky', 'mastodon', 'instagram', 'githubDiscussions'], 'Reddit only when a launch.yml asks for it');
});

test('enabled must be written out', () => {
  const result = parseLaunchConfig('brand: personal\n');
  assert.ok(!result.ok);
  assert.equal(result.issues[0]?.path, 'enabled');
});

test('a draft for the owner to post by hand is gone: manual is refused, pointing at the line', () => {
  const result = parseLaunchConfig(`enabled: true
brand: personal
publishing:
  blog: approval
  reddit: manual
`);
  assert.ok(!result.ok);
  const issue = result.issues.find((i) => i.path === 'publishing.reddit');
  assert.ok(issue, JSON.stringify(result.issues));
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

test('a launch.yml may name further repos and pages; left out, the parsed file is what it was', () => {
  const plain = parseLaunchConfig('enabled: true\nbrand: personal\n');
  assert.ok(plain.ok);
  assert.equal('sources' in plain.value, false, 'no key added to a file without it');
  const named = parseLaunchConfig('enabled: true\nbrand: personal\nsources:\n  repos: [yeyo11/claudio-web]\n  urls: [https://claudio.example/]\n');
  assert.ok(named.ok);
  assert.deepEqual(named.value.sources, { repos: ['yeyo11/claudio-web'], urls: ['https://claudio.example/'] });
  const pagesOnly = parseLaunchConfig('enabled: true\nbrand: personal\nsources:\n  urls: [https://claudio.example/]\n');
  assert.ok(pagesOnly.ok);
  assert.deepEqual(pagesOnly.value.sources?.repos, []);
  const wrong = parseLaunchConfig('enabled: true\nbrand: personal\nsources:\n  repos: [claudio]\n  urls: [ftp://x]\n  pages: []\n');
  assert.ok(!wrong.ok);
  const said = formatIssues('launch.yml', wrong.issues);
  assert.match(said, /owner\/name/);
  assert.match(said, /http or https/);
});
