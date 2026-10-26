import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dateToDay, dayToDate, formatDay, formatRange } from '../src/components/ui/dates.ts';

test('a day goes to a local date and back without sliding', () => {
  for (const day of ['2026-01-01', '2026-03-29', '2026-10-25', '2028-02-29']) assert.equal(dateToDay(dayToDate(day)!), day);
});

test('a day that does not exist is refused instead of rolling over', () => {
  assert.equal(dayToDate('2026-02-31'), undefined);
  assert.equal(dayToDate('2026-2-1'), undefined);
  assert.equal(dayToDate(''), undefined);
  assert.equal(dayToDate(undefined), undefined);
});

test('days read day first', () => {
  assert.match(formatDay('2026-10-01'), /Thu,? 1 Oct 2026/);
  assert.equal(formatDay('2026-10-01', true), '1 Oct 2026');
  assert.equal(formatDay('nope'), 'nope');
});

test('a range names the year once when both ends share it', () => {
  assert.equal(formatRange('2026-10-01', '2026-10-31'), '1 Oct – 31 Oct 2026');
  assert.equal(formatRange('2025-12-20', '2026-01-03'), '20 Dec 2025 – 3 Jan 2026');
  assert.equal(formatRange('2026-10-01', '2026-10-01'), '1 Oct 2026');
  assert.equal(formatRange('2026-10-01', ''), 'From 1 Oct 2026');
  assert.equal(formatRange('', ''), '');
});
