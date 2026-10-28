import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ShipcastError } from '@shipcast/schema';
import { ConnectorError, PostGone } from '../src/index.ts';

// Characterisation of the connectors' errors, pinned before they took the shared base

test('a connector error names its network, and is retryable by its status unless told otherwise', () => {
  const error = new ConnectorError('dev.to', 'publish: 401 nope', 401);
  assert.ok(error instanceof Error);
  assert.equal(error.message, 'dev.to: publish: 401 nope');
  assert.equal(error.name, 'Error');
  assert.equal(error.network, 'dev.to');
  assert.equal(error.status, 401);
  assert.equal(error.retryable, false);
  assert.equal(new ConnectorError('x', 'm').retryable, true, 'no status: a network that did not answer');
  assert.equal(new ConnectorError('x', 'm', 429).retryable, true);
  assert.equal(new ConnectorError('x', 'm', 500).retryable, true);
  assert.equal(new ConnectorError('x', 'm', 499).retryable, false);
  assert.equal(new ConnectorError('x', 'm', 503, false).retryable, false);
  assert.equal(new ConnectorError('x', 'm', 400, true).retryable, true);
});

test('a post gone is a connector error that is never retried', () => {
  const gone = new PostGone('Bluesky', 'the post x no longer exists', 400);
  assert.ok(gone instanceof ConnectorError);
  assert.equal(gone.name, 'PostGone');
  assert.equal(gone.message, 'Bluesky: the post x no longer exists');
  assert.equal(gone.status, 400);
  assert.equal(gone.retryable, false);
  assert.equal(new PostGone('Mastodon', 'gone', 503).retryable, false);
});

test('a connector error is a Shipcast error: the network’s failure, a 502', () => {
  const error = new ConnectorError('x', 'm', 500);
  assert.ok(error instanceof ShipcastError);
  assert.deepEqual([error.code, error.httpStatus, error.retryable], ['upstream', 502, true]);
  const gone = new PostGone('x', 'm', 404);
  assert.deepEqual([gone instanceof ShipcastError, gone.code, gone.httpStatus, gone.retryable], [true, 'upstream', 502, false]);
});
