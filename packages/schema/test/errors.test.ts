import assert from 'node:assert/strict';
import { test } from 'node:test';
import { httpStatusOf, Refused, ShipcastError } from '../src/index.ts';

test('a Shipcast error is internal, final and a 500 unless it says otherwise', () => {
  const plain = new ShipcastError('boom');
  assert.ok(plain instanceof Error);
  assert.deepEqual([plain.message, plain.name, plain.code, plain.retryable, plain.httpStatus, plain.cause], ['boom', 'Error', 'internal', false, 500, undefined]);
  const cause = new Error('under');
  const said = new ShipcastError('later', { code: 'busy', retryable: true, httpStatus: 503, cause });
  assert.deepEqual([said.code, said.retryable, said.httpStatus, said.cause], ['busy', true, 503, cause]);
});

test('a refusal answers by its reason: 404, 400, else 409', () => {
  assert.deepEqual(
    (['not_found', 'invalid', 'unsupported', 'state'] as const).map((r) => {
      const refused = new Refused(r, 'no');
      return [refused.reason, refused.code, refused.httpStatus, refused.retryable];
    }),
    [
      ['not_found', 'not_found', 404, false],
      ['invalid', 'invalid', 400, false],
      ['unsupported', 'unsupported', 409, false],
      ['state', 'state', 409, false],
    ],
  );
});

test('httpStatusOf answers a Shipcast error by its own status, anything else with 500', () => {
  assert.equal(httpStatusOf(new Refused('not_found', 'x')), 404);
  assert.equal(httpStatusOf(new Error('x')), 500);
  assert.equal(httpStatusOf('x'), 500);
});
