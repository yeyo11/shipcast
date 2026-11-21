import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clientGone } from '../src/server/client-gone.ts';

test('a client that left aborts the request with an AbortError', () => {
  const reason = clientGone();
  assert.equal(reason.name, 'AbortError');
  const controller = new AbortController();
  controller.abort(reason);
  assert.equal(controller.signal.reason, reason);
});

test('the abort carries an HTTP status, so TanStack Start does not log it as a failure', () => {
  // resolveErrorStatus (start-server-core) logs every error whose `status` is not 400-599
  const { status } = clientGone() as unknown as { status: unknown };
  assert.equal(status, 499);
});
