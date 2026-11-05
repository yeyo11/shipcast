import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aiTabOf, CLAUDIO_HELP, lockedRuleCount, promptEdited, promptLabel, readAiTab } from '../src/components/settings/ai.ts';
import { ago, changesText, everyText, hostOf, listeningText, oauthPart, settingHelp, tokenUse } from '../src/components/settings/view.ts';
import { ruleTitle, ruleWithout } from '../src/components/settings/rules.ts';

const NOW = Date.parse('2026-10-31T12:00:00Z');

test('the save bar counts its changes in words', () => {
  assert.equal(changesText(1), '1 change not saved');
  assert.equal(changesText(3), '3 changes not saved');
});

test('a past moment reads as minutes, hours, then the day', () => {
  assert.equal(ago('2026-10-31T11:59:40Z', NOW), 'just now');
  assert.equal(ago('2026-10-31T11:48:00Z', NOW), '12 min ago');
  assert.equal(ago('2026-10-31T09:00:00Z', NOW), '3 h ago');
  assert.equal(ago('2026-10-12T09:00:00Z', NOW), '12 Oct');
  assert.equal(ago('not a date', NOW), 'not a date');
});

test('an address loses its scheme and trailing slash', () => {
  assert.equal(hostOf('http://claudio.local:8790/'), 'claudio.local:8790');
});

test('a network app setting says which network it is for; others say what they are for', () => {
  assert.deepEqual(oauthPart('The LinkedIn client id'), { network: 'LinkedIn', part: 'id' });
  assert.deepEqual(oauthPart('The Instagram app secret'), { network: 'Instagram', part: 'secret' });
  assert.equal(oauthPart('The launches repo'), null);
  assert.equal(settingHelp({ name: 'linkedinClientId', label: 'The LinkedIn client id', source: 'unset' }), 'From your LinkedIn app. Needed to connect LinkedIn.');
  // No network is called Meta: its app is what Facebook and Instagram's Meta logins sign in with
  assert.equal(settingHelp({ name: 'metaAppId', label: 'The Meta app id', source: 'unset' }), 'From your Meta app. Needed to connect Facebook, and Instagram through Unified or Facebook Login.');
  assert.equal(settingHelp({ name: 'linkedinClientSecret', label: 'The LinkedIn client secret', source: 'keychain' }), null);
  assert.equal(settingHelp({ name: 'linkedinClientSecret', label: 'The LinkedIn client secret', source: '.env' }), 'Read from .env until it is saved here.');
  assert.match(settingHelp({ name: 'launchesRepo', label: 'The launches repo', source: 'settings' }) ?? '', /drafts/);
});

test('a token says its scopes and when it was last used', () => {
  assert.equal(tokenUse({ scopes: ['read', 'write'], lastUsedAt: '2026-10-31T11:00:00Z' }, NOW), 'Read, Write · used 1 h ago');
  assert.equal(tokenUse({ scopes: ['read'], lastUsedAt: null }, NOW), 'Read · never used');
});

test('how Shipcast hears about GitHub, in words', () => {
  assert.equal(everyText(300), '5 minutes');
  assert.equal(everyText(60), 'minute');
  assert.equal(everyText(90), '90 seconds');
  assert.equal(listeningText({ mode: 'webhook', intervalSeconds: 300, lastDelivery: { at: '2026-10-31T11:58:00Z' } }, NOW), 'Receiving · last delivery 2 min ago');
  assert.equal(listeningText({ mode: 'webhook', intervalSeconds: 300, lastDelivery: null }, NOW), 'Receiving · nothing received yet');
  assert.equal(listeningText({ mode: 'poll', intervalSeconds: 300, lastDelivery: null }, NOW), 'Not in use: Shipcast polls every 5 minutes');
});

test('a trigger rule reads as its event and what a repo without launch.yml gets', () => {
  assert.equal(ruleTitle({ event: 'release', prereleases: true }), 'A release is published, pre-releases too');
  assert.equal(ruleTitle({ event: 'public', prereleases: false }), 'A repo is made public');
  assert.equal(ruleWithout({ channels: null }), 'Leave it alone');
  assert.equal(ruleWithout({ channels: [] }), 'Launch it on no channel');
  assert.match(ruleWithout({ channels: ['blog'] }), /^Launch it on /);
});

test('prompts: their names, whether one is edited and how many rules are locked', () => {
  assert.equal(promptLabel('reply'), 'A reply to a comment');
  assert.equal(promptLabel('pack.launch'), 'A first launch');
  assert.equal(promptLabel('pack.minor'), 'A minor version');
  assert.equal(promptEdited({ default: 'a', versions: [] }), false);
  assert.equal(promptEdited({ default: 'a', versions: [{ text: 'b' }] }), true);
  assert.equal(promptEdited({ default: 'a', versions: [{ text: 'b' }, { text: 'a' }] }), false);
  assert.equal(lockedRuleCount({ a: ['1', '2'], b: ['3'], schema: '{}' }), 4);
});

test('Settings › AI opens the tab its address or an old section anchor names', () => {
  assert.equal(readAiTab({ tab: 'tone' }), 'tone');
  assert.equal(readAiTab({ tab: 'providers' }), undefined);
  assert.equal(readAiTab({ tab: 'nope' }), undefined);
  assert.equal(readAiTab({}), undefined);
  assert.equal(aiTabOf('prompts', '#st-tone'), 'prompts');
  assert.equal(aiTabOf(undefined, '#st-tone'), 'tone');
  assert.equal(aiTabOf(undefined, '#st-tasks-d'), 'tasks');
  assert.equal(aiTabOf(undefined, 'st-prompts'), 'prompts');
  assert.equal(aiTabOf(undefined, '#elsewhere'), 'providers');
  assert.equal(aiTabOf(undefined, ''), 'providers');
});

test('claudio is explained in one short sentence that links to its repository', () => {
  assert.match(CLAUDIO_HELP.text, /^claudio /, 'written lowercase, as the app names it');
  assert.ok(CLAUDIO_HELP.text.split(/\s+/).length <= 25);
  assert.equal(CLAUDIO_HELP.href, 'https://github.com/yeyo11/claudio');
});
