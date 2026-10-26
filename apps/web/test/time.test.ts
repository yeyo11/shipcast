import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatTime, parseTime, stepTime, typeTime } from '../src/components/ui/dates.ts';

test('parseTime reads a real 24-hour time and refuses anything else', () => {
  assert.deepEqual(parseTime('09:05'), { hour: 9, minute: 5 });
  assert.deepEqual(parseTime('23:59'), { hour: 23, minute: 59 });
  for (const bad of [undefined, '', '9:05', '24:00', '12:60', '12:5', '12:00:00', 'ab:cd']) assert.equal(parseTime(bad), undefined);
});

test('formatTime pads to the text the server helpers read', () => {
  assert.equal(formatTime({ hour: 0, minute: 7 }), '00:07');
  assert.equal(formatTime({ hour: 18, minute: 30 }), '18:30');
});

test('stepTime wraps each unit without carrying into the other', () => {
  assert.deepEqual(stepTime({ hour: 23, minute: 30 }, 'hour', 1), { hour: 0, minute: 30 });
  assert.deepEqual(stepTime({ hour: 0, minute: 30 }, 'hour', -1), { hour: 23, minute: 30 });
  assert.deepEqual(stepTime({ hour: 8, minute: 59 }, 'minute', 1), { hour: 8, minute: 0 });
  assert.deepEqual(stepTime({ hour: 8, minute: 0 }, 'minute', -1), { hour: 8, minute: 59 });
  assert.deepEqual(stepTime({ hour: 8, minute: 0 }, 'minute', 10), { hour: 8, minute: 10 });
});

test('typeTime joins a typed digit to the last one shown and stops at the limit', () => {
  assert.deepEqual(typeTime({ hour: 1, minute: 0 }, 'hour', '017'), { hour: 17, minute: 0 });
  assert.deepEqual(typeTime({ hour: 1, minute: 0 }, 'hour', '019'), { hour: 19, minute: 0 });
  assert.deepEqual(typeTime({ hour: 2, minute: 0 }, 'hour', '029'), { hour: 23, minute: 0 });
  assert.deepEqual(typeTime({ hour: 0, minute: 5 }, 'minute', '059'), { hour: 0, minute: 59 });
  assert.deepEqual(typeTime({ hour: 0, minute: 0 }, 'minute', '7'), { hour: 0, minute: 7 });
  assert.equal(typeTime({ hour: 0, minute: 0 }, 'minute', 'x'), undefined);
  assert.equal(typeTime({ hour: 0, minute: 0 }, 'minute', ''), undefined);
});
