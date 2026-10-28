import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Launch } from '@shipcast/engine';
import { Brand } from '@shipcast/schema';
import { followJob } from '../src/components/assistant/follow.ts';
import { readEvents, type AssistantEvent } from '../src/components/assistant/protocol.ts';
import type { Interest, LiveEvent } from '../src/components/live/client.ts';
import { handleAssistant, type AssistantDeps } from '../src/server/assistant.ts';

/*
 * With `ai-runner` the check against the code leaves the page's request: the endpoint queues it and
 * answers the job's id, and the page follows the job (its live events, or a slow read) to its result.
 */

const brand = Brand.parse({ id: 'personal', displayName: 'Me', site: 'https://josegarrido.dev', github: 'yeyo11' });
const at = '2026-10-26T00:00:00.000Z';
const release: Launch = { id: 7, repo: 'yeyo11/claudio', ref: 'v1.0.0', trigger: 'release', kind: 'launch', brand: 'personal', status: 'drafted', detail: null, createdAt: at, updatedAt: at };

test('the check is queued as a job and its id answered: nothing is cloned nor asked of the AI in the request', async () => {
  const started: Array<{ launch: number; text: string; channel?: string }> = [];
  const deps: AssistantDeps = {
    setup: async () => assert.fail('no provider is set up for a queued check'),
    brand: async () => brand,
    launch: async (id) => (id === release.id ? release : undefined),
    grounding: async (launch) => ({ kind: 'launch', launch: { repo: launch.repo, ref: launch.ref } }),
    checkout: async () => assert.fail('the request clones nothing'),
    startCheck: async (launch, request) => {
      started.push({ launch: launch.id, ...request });
      return 'job-42';
    },
  };
  const request = new Request('http://app/api/assistant', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'check', selection: 'It runs on Windows.', document: 'It runs on Windows. More.', launchId: 7, channel: 'bluesky' }) });
  const response = await handleAssistant(request, async () => deps);
  const events: AssistantEvent[] = [];
  for await (const event of readEvents(response.body!)) events.push(event);
  assert.deepEqual(events, [{ type: 'whole' }, { type: 'job', id: 'job-42' }]);
  assert.deepEqual(started, [{ launch: 7, text: 'It runs on Windows.', channel: 'bluesky' }]);
});

/** A live client that hands the test the interest registered */
function fakeLive() {
  const registered: Interest[] = [];
  let unregistered = 0;
  return {
    registered,
    get unregistered() {
      return unregistered;
    },
    register(interest: Interest) {
      registered.push(interest);
      return () => void unregistered++;
    },
  };
}

const ended = (id: string, state = 'completed'): LiveEvent => ({ kind: 'job', data: { id, queue: 'assistant-check', state } });

test('the page follows the job through its live events and reads the result once it has ended', async () => {
  const live = fakeLive();
  let reads = 0;
  let done = false;
  const following = followJob('job-42', { live, read: async () => (reads++, done ? { revised: 'R' } : undefined) });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(reads, 1, 'read once at the start, in case it ended already');
  const interest = live.registered[0]!;
  assert.deepEqual(interest.topics, ['job']);
  assert.equal(interest.accepts!(ended('job-41')), false, 'another job’s end is not this one');
  assert.equal(interest.accepts!(ended('job-42', 'active')), false, 'a log line is not its end');
  assert.equal(interest.accepts!(ended('job-42')), true);
  done = true;
  interest.reload();
  assert.deepEqual(await following, { revised: 'R' });
  assert.equal(live.unregistered, 1, 'the interest is dropped once it has its result');
});

test('without live events the job is read on a slow tick, and the page leaving stops it', async () => {
  const ticks: Array<() => void> = [];
  let cleared = 0;
  let done = false;
  const clock = { setInterval: (fn: () => void) => (ticks.push(fn), ticks.length), clearInterval: () => void cleared++ };
  const result = followJob('job-1', { ...clock, read: async () => (done ? 'ok' : undefined) });
  await new Promise((r) => setTimeout(r, 0));
  done = true;
  ticks[0]!();
  assert.equal(await result, 'ok');
  assert.equal(cleared, 1);

  const controller = new AbortController();
  const left = followJob('job-2', { ...clock, read: async () => undefined, signal: controller.signal });
  controller.abort(new Error('the editor closed'));
  await assert.rejects(left, /the editor closed/);
});
