import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Refused, ShipcastError } from '@shipcast/schema';
import { AssistantRefused, CommentRefused, PostRefused, ProfileRefused, ScheduleRefused } from '../src/index.ts';

// Characterisation of the engine's refusals, pinned before they took the shared base: callers tell
// them apart with instanceof and answer by their reason

test('each refusal carries its reason and message, and is only itself', () => {
  const refusals = [new PostRefused('not_found', 'a'), new ScheduleRefused('invalid', 'b'), new ProfileRefused('reconnect', 'c'), new CommentRefused('state', 'd')];
  assert.deepEqual(
    refusals.map((r) => [r.reason, r.message, r.name, r instanceof Error]),
    [
      ['not_found', 'a', 'Error', true],
      ['invalid', 'b', 'ScheduleRefused', true],
      ['reconnect', 'c', 'Error', true],
      ['state', 'd', 'Error', true],
    ],
  );
  const [post, schedule, profile, comment] = refusals;
  assert.ok(!(post instanceof ScheduleRefused) && !(post instanceof ProfileRefused) && !(post instanceof CommentRefused));
  assert.ok(!(schedule instanceof PostRefused) && !(profile instanceof PostRefused) && !(comment instanceof PostRefused));
  const assistant = new AssistantRefused('no code');
  assert.equal(assistant.message, 'no code');
  assert.ok(assistant instanceof Error && !(assistant instanceof PostRefused));
});

test('every refusal is a Shipcast error answering by its reason', () => {
  assert.deepEqual(
    [new PostRefused('not_found', 'a'), new ScheduleRefused('invalid', 'b'), new ProfileRefused('reconnect', 'c'), new CommentRefused('state', 'd'), new AssistantRefused('e')].map((r) => [
      r instanceof ShipcastError,
      r instanceof Refused,
      r.code,
      r.httpStatus,
      r.retryable,
    ]),
    [
      [true, true, 'not_found', 404, false],
      [true, true, 'invalid', 400, false],
      [true, true, 'reconnect', 409, false],
      [true, true, 'state', 409, false],
      [true, false, 'refused', 409, false],
    ],
  );
});
