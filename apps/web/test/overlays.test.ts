import assert from 'node:assert/strict';
import { test } from 'node:test';
import { menuStep, overlayShape } from '../src/components/kit/overlay-shape.ts';
import { PHONE_QUERY } from '../src/components/kit/usePhone.ts';
import { desktopMenuEntries, launchMenuEntries, type LaunchMenuState } from '../src/components/launch/launch-menu.ts';
import { canRelaunch } from '../src/server/launch-list.ts';

test('every overlay is the bottom sheet on a phone and its own shape from 960 px', () => {
  for (const kind of ['menu', 'drawer', 'dialog', 'popover'] as const) {
    assert.equal(overlayShape(kind, true), 'sheet');
    assert.equal(overlayShape(kind, false), kind);
  }
  // The switch follows the window's width at the kit's breakpoint, never the kind of pointer
  assert.equal(PHONE_QUERY, '(max-width: 959px)');
  assert.doesNotMatch(PHONE_QUERY, /pointer/);
});

test("a menu's arrows wrap around its items, Home and End reach its ends", () => {
  assert.equal(menuStep('ArrowDown', -1, 3), 0);
  assert.equal(menuStep('ArrowDown', 2, 3), 0);
  assert.equal(menuStep('ArrowUp', -1, 3), 2);
  assert.equal(menuStep('ArrowUp', 0, 3), 2);
  assert.equal(menuStep('Home', 2, 3), 0);
  assert.equal(menuStep('End', 0, 3), 2);
  assert.equal(menuStep('Tab', 0, 3), null);
  assert.equal(menuStep('ArrowDown', -1, 0), null);
});

const quiet: LaunchMenuState = {
  relaunch: false,
  waiting: false,
  held: false,
  article: false,
  pending: false,
  running: false,
  failed: false,
  problem: false,
  editable: 0,
  removable: 0,
  deletable: false,
};

test('a release that failed before anything went out offers Launch it again, its log and its error, whatever the tab', () => {
  const launch = { status: 'failed', ref: 'v2.0.0', posts: [] };
  const entries = launchMenuEntries({ ...quiet, relaunch: canRelaunch(launch), failed: true, problem: true, deletable: true });
  assert.deepEqual(entries, ['relaunch', 'log', 'copy-error', 'delete']);
  // On a desktop "Launch it again" is the page's yellow button, so the menu leaves it out and still has the rest
  assert.deepEqual(desktopMenuEntries(entries), ['log', 'copy-error', 'delete']);
});

test('a failed launch that published something, or an article, is not launched again from the menu', () => {
  const partly = { status: 'failed', ref: 'v1.5.0', posts: [{ id: 1 }] };
  assert.deepEqual(launchMenuEntries({ ...quiet, relaunch: canRelaunch(partly), failed: true, problem: true, editable: 2, removable: 2 }), ['log', 'copy-error', 'edit-out', 'unpublish']);
  const article = { status: 'failed', ref: 'article:notes', posts: [] };
  assert.equal(launchMenuEntries({ ...quiet, relaunch: canRelaunch(article), failed: true }).includes('relaunch'), false);
});

test('with nothing to offer the menu is empty, so the page shows no ⋯', () => {
  assert.deepEqual(launchMenuEntries(quiet), []);
  assert.deepEqual(launchMenuEntries({ ...quiet, pending: true, running: true }), []);
  // Delete stays behind its flag: deletable is false without launch-delete
  assert.deepEqual(launchMenuEntries({ ...quiet, deletable: true }), ['delete']);
});

test('a published launch keeps its article, its edits and its unpublish', () => {
  assert.deepEqual(launchMenuEntries({ ...quiet, article: true, editable: 3, removable: 3, deletable: true }), ['article', 'edit-out', 'unpublish', 'delete']);
  assert.deepEqual(launchMenuEntries({ ...quiet, waiting: true, held: true }), ['edit-text', 'preview']);
});
