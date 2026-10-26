import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseBrand } from '@shipcast/schema';
import { after, answerTour, complete, finish, initialState, minimalBrand, readState, reconcile, remaining, resumeAt, setAside, skip, STEPS, type Detected } from '../src/server/onboarding.ts';

const none: Detected = { brand: false, ai: false, channels: false, measure: false, automation: false };
const now = new Date('2026-10-26T10:00:00.000Z');

test('a new install starts with every step pending and opens the onboarding by itself', () => {
  const state = initialState(none, { hasLaunches: false }, now);
  assert.deepEqual(Object.values(state.steps), ['pending', 'pending', 'pending', 'pending', 'pending']);
  assert.equal(state.autoOpen, true);
  assert.equal(state.createdAt, now.toISOString());
  assert.equal(resumeAt(state), 'brand');
});

test('an install already configured is detected: its steps are done and nothing opens by itself', () => {
  const configured: Detected = { brand: true, ai: true, channels: true, measure: false, automation: true };
  const state = initialState(configured, { hasLaunches: true }, now);
  assert.deepEqual(state.steps, { brand: 'done', ai: 'done', channels: 'done', measure: 'pending', automation: 'done' });
  assert.equal(state.autoOpen, false, 'the owner’s working install is never walked through it');
  assert.deepEqual(remaining(state), ['measure']);
});

test('an install with launches but no brand yet does not open the onboarding by itself either', () => {
  assert.equal(initialState(none, { hasLaunches: true }, now).autoOpen, false);
  assert.equal(initialState({ ...none, brand: true }, { hasLaunches: false }, now).autoOpen, false);
});

test('skip leaves a step for later, and resuming starts at the first pending, then the first skipped', () => {
  let state = initialState(none, { hasLaunches: false }, now);
  state = skip(state, 'brand');
  state = skip(state, 'ai');
  assert.equal(state.steps.brand, 'skipped');
  assert.equal(resumeAt(state), 'channels');
  state = complete(complete(complete(state, 'channels'), 'measure'), 'automation');
  assert.equal(resumeAt(state), 'brand', 'only skipped steps are left: back to the first');
  assert.deepEqual(remaining(state), ['brand', 'ai']);
  state = complete(complete(state, 'brand'), 'ai');
  assert.equal(resumeAt(state), undefined);
});

test('skipping a done step never undoes it', () => {
  const state = complete(initialState(none, { hasLaunches: false }, now), 'ai');
  assert.equal(skip(state, 'ai').steps.ai, 'done');
});

test('reconcile marks what got configured since as done, and never reopens a done step', () => {
  let state = skip(initialState(none, { hasLaunches: false }, now), 'channels');
  state = reconcile(state, { ...none, channels: true });
  assert.equal(state.steps.channels, 'done');
  state = reconcile(state, none);
  assert.equal(state.steps.channels, 'done', 'a channel disconnected later does not reset the step');
});

test('finishing or setting it aside stops it opening by itself, and the tour is offered once', () => {
  const start = initialState(none, { hasLaunches: false }, now);
  const aside = setAside(start);
  assert.equal(aside.autoOpen, false);
  assert.equal(aside.tour, undefined);
  const finished = finish(start, now);
  assert.equal(finished.autoOpen, false);
  assert.equal(finished.tour, 'offered');
  assert.equal(finished.finishedAt, now.toISOString());
  assert.equal(finish(answerTour(finished, 'declined'), new Date()).tour, 'declined', 'finishing again does not offer it again');
  assert.equal(answerTour(start, 'taken').autoOpen, false);
});

test('a stored state is read back defensively', () => {
  assert.equal(readState(null), undefined);
  assert.equal(readState('nope'), undefined);
  const read = readState({ steps: { brand: 'done', ai: 'weird' }, autoOpen: 'yes', tour: 'maybe' });
  assert.deepEqual(read?.steps, { brand: 'done', ai: 'pending', channels: 'pending', measure: 'pending', automation: 'pending' });
  assert.equal(read?.autoOpen, false);
  assert.equal(read?.tour, undefined);
});

test('the steps run in order, the last one has none after it', () => {
  assert.deepEqual([...STEPS], ['brand', 'ai', 'channels', 'measure', 'automation']);
  assert.equal(after('brand'), 'ai');
  assert.equal(after('automation'), undefined);
});

test('the minimal brand.yml validates', () => {
  const yaml = minimalBrand({ id: 'me', displayName: 'Jo "the dev"', site: 'https://example.dev/', github: 'jo', languages: ['en', 'es'] });
  const parsed = parseBrand(yaml);
  assert.ok(parsed.ok, yaml);
  assert.equal(parsed.ok && parsed.value.displayName, 'Jo "the dev"');
  assert.equal(parsed.ok && parsed.value.site, 'https://example.dev');
});
