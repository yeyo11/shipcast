import assert from 'node:assert/strict';
import { test } from 'node:test';
import { notchFor, phoneSide, tourSteps } from '../src/components/tour/steps.ts';

test('the notch sits on the card edge facing the target, along it as the card is aligned', () => {
  assert.deepEqual(notchFor('bottom-left'), { edge: 'top', align: 'start' });
  assert.deepEqual(notchFor('bottom-right'), { edge: 'top', align: 'end' });
  assert.deepEqual(notchFor('top'), { edge: 'bottom', align: 'center' });
  assert.deepEqual(notchFor('top-left'), { edge: 'bottom', align: 'start' });
  assert.deepEqual(notchFor('left'), { edge: 'right', align: 'center' });
  assert.deepEqual(notchFor('left-bottom'), { edge: 'right', align: 'end' });
  assert.deepEqual(notchFor('right-top'), { edge: 'left', align: 'start' });
  assert.equal(notchFor(''), null);
  assert.equal(notchFor('middle'), null);
});

test('every step with a target has a side the notch can point from, and the routes chain up', () => {
  for (const launchId of [null, 7]) {
    const steps = tourSteps({ launchId });
    for (const step of steps) if (step.selector) assert.ok(step.side && notchFor(step.side), `${step.title} has a side with a notch`);
    steps.forEach((step, i) => {
      const next = steps[i + 1];
      if (next && next.route !== step.route) assert.equal(step.nextRoute, next.route);
    });
  }
});

test('on a phone no card sits beside its target: it goes above it, lined up with its far edge', () => {
  assert.equal(phoneSide('left'), 'top-right');
  assert.equal(phoneSide('left-bottom'), 'top-right');
  assert.equal(phoneSide('right'), 'top-left');
  assert.equal(phoneSide('bottom-left'), 'bottom-left');
  const assistant = (phone: boolean) => tourSteps({ launchId: 1, phone }).find((s) => s.selector?.includes('assistant'))?.side;
  assert.equal(assistant(false), 'left');
  assert.equal(assistant(true), 'top-right');
});
