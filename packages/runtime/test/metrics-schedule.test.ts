import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHECKS_CRON, METRICS_CRON, PROBE_CRON, QUEUES, ROUND_WATCHDOG_CRON } from '../src/index.ts';

/*
 * The metrics job runs every 5 minutes (docs/publishing.md, "Two schedules"), on minutes no other
 * cron of Shipcast takes, and a run never starts while the one before is still running: the queue is
 * stately with one job at a time, and every run the cron sends shares one key (none), so a run that
 * outlasts 5 minutes leaves at most one waiting and the cron's later sends are dropped.
 */

const minutesOf = (cron: string): number[] => {
  const [field] = cron.split(' ');
  const out: number[] = [];
  for (const part of field!.split(',')) {
    const [range, step] = part.split('/');
    const [from, to] = range === '*' ? [0, 59] : range!.includes('-') ? range!.split('-').map(Number) : [Number(range), step ? 59 : Number(range)];
    for (let m = from!; m <= to!; m += Number(step ?? 1)) out.push(m);
  }
  return out;
};

test('the metrics job runs every 5 minutes, off the other crons’ minutes', () => {
  const minutes = minutesOf(METRICS_CRON);
  assert.equal(minutes.length, 12);
  for (let i = 1; i < minutes.length; i++) assert.equal(minutes[i]! - minutes[i - 1]!, 5);
  assert.ok(METRICS_CRON.endsWith(' * * * *'), 'every hour');
  const taken = new Set([...minutesOf(CHECKS_CRON), ...minutesOf(PROBE_CRON), ...minutesOf(ROUND_WATCHDOG_CRON)]);
  assert.deepEqual(minutes.filter((m) => taken.has(m)), []);
});

test('one metrics run at a time, and a failed one is retried before the next two runs', () => {
  assert.equal(QUEUES.metrics.policy, 'stately');
  assert.equal(QUEUES.metrics.concurrency, 1);
  assert.ok(QUEUES.metrics.retryDelay !== undefined && QUEUES.metrics.retryDelay <= 5 * 60, 'not 15 minutes behind a 5-minute cadence');
});
