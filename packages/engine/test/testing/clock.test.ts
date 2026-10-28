import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FakeClock } from '../../src/testing/clock.ts';

test('the clock moves only when told, and hands out copies', () => {
  const clock = new FakeClock('2026-11-03T09:00:00.000Z');
  const { now } = clock;
  const first = now();
  first.setFullYear(2000);
  assert.equal(clock.iso, '2026-11-03T09:00:00.000Z', 'changing an answer changes nothing');
  clock.advance({ hours: 2, minutes: 30 });
  assert.equal(now().toISOString(), '2026-11-03T11:30:00.000Z');
  assert.equal(clock.in({ days: 1 }).toISOString(), '2026-11-04T11:30:00.000Z');
  assert.equal(clock.iso, '2026-11-03T11:30:00.000Z', 'in() does not move it');
  clock.set('2026-12-01T00:00:00Z');
  assert.equal(clock.date.toISOString(), '2026-12-01T00:00:00.000Z');
});
