import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_TRIGGER_RULES, matchingRule, repoMatches, TriggerRule, TriggerRules } from '../src/index.ts';

test('a repo pattern names every repo, an account’s, or one, case-insensitively', () => {
  assert.equal(repoMatches('*', 'yeyo11/claudio'), true);
  assert.equal(repoMatches('yeyo11/*', 'Yeyo11/Claudio'), true);
  assert.equal(repoMatches('yeyo11/*', 'yeyo111/claudio'), false, 'not an account whose name starts the same');
  assert.equal(repoMatches('yeyo11/claudio', 'yeyo11/claudio-web'), false);
});

test('an event takes the first enabled rule it matches; a pre-release only one that takes pre-releases', () => {
  const rules = TriggerRules.parse([
    { id: 'off', event: 'release', repos: 'yeyo11/*', enabled: false },
    { id: 'claudio', event: 'release', repos: 'yeyo11/claudio' },
    { id: 'betas', event: 'release', prereleases: true },
  ]);
  assert.equal(matchingRule(rules, { type: 'release', repo: 'yeyo11/claudio' })?.id, 'claudio');
  assert.equal(matchingRule(rules, { type: 'release', repo: 'yeyo11/claudio', prerelease: true })?.id, 'betas');
  assert.equal(matchingRule(rules, { type: 'public', repo: 'yeyo11/claudio' }), undefined);
});

test('the defaults launch as launch.yml alone did, and a rule fills in what it leaves out', () => {
  assert.deepEqual(
    DEFAULT_TRIGGER_RULES.map((r) => [r.event, r.repos, r.channels]),
    [
      ['release', '*', null],
      ['public', '*', null],
    ],
  );
  assert.deepEqual(TriggerRule.parse({ id: 'a', event: 'release' }), { id: 'a', enabled: true, event: 'release', repos: '*', prereleases: false, channels: null });
  assert.equal(TriggerRules.safeParse([{ id: 'a', event: 'release' }, { id: 'a', event: 'public' }]).success, false, 'ids are unique');
  assert.equal(TriggerRule.safeParse({ id: 'a', event: 'release', channels: ['myspace'] }).success, false);
});
