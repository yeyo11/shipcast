import assert from 'node:assert/strict';
import { test } from 'node:test';
import { currentSettingsPage, inSettings } from '../src/server/settings-pages.ts';

test('General is /settings exactly, a trailing slash included', () => {
  assert.equal(currentSettingsPage('/settings'), '/settings');
  assert.equal(currentSettingsPage('/settings/'), '/settings');
});

test('each sub-page owns its path and what is under it', () => {
  assert.equal(currentSettingsPage('/settings/ai'), '/settings/ai');
  assert.equal(currentSettingsPage('/settings/automation/'), '/settings/automation');
  assert.equal(currentSettingsPage('/settings/api/tokens'), '/settings/api');
});

test('a shared prefix is not a match, and outside Settings nothing is current', () => {
  assert.equal(currentSettingsPage('/settings/aix'), null);
  assert.equal(currentSettingsPage('/settings/apis'), null);
  assert.equal(currentSettingsPage('/settingsx'), null);
  assert.equal(currentSettingsPage('/stats'), null);
  assert.equal(currentSettingsPage('/'), null);
});

test('the section is current on any Settings path, and only there', () => {
  assert.equal(inSettings('/settings'), true);
  assert.equal(inSettings('/settings/ai'), true);
  assert.equal(inSettings('/settings/unknown'), true);
  assert.equal(inSettings('/settingsx'), false);
  assert.equal(inSettings('/channels'), false);
});
