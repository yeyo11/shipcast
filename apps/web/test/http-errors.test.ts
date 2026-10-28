import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConnectorError } from '@shipcast/connectors';
import { CommentRefused, InvalidPeriod, PostRefused, ScheduleRefused } from '@shipcast/engine';
import { SettingMissing } from '@shipcast/runtime';
import { ApiError, apiErrorOf, forOwner, reasonOf } from '../src/server/errors.ts';
import { InvalidInput } from '../src/server/input.ts';

const mapped = (error: unknown) => {
  const e = apiErrorOf(error);
  return `${e.status} ${e.code} ${e.message}`;
};

test('one mapping answers every area’s refusal by its own status', () => {
  assert.equal(mapped(new PostRefused('not_found', 'no such post')), '404 not_found no such post');
  assert.equal(mapped(new ScheduleRefused('invalid', 'bad time')), '400 invalid_input bad time');
  assert.equal(mapped(new CommentRefused('state', 'sent already')), '409 refused sent already');
  assert.equal(mapped(new InvalidInput('limit is an integer')), '400 invalid_input limit is an integer');
  assert.equal(mapped(new InvalidPeriod('to comes after from')), '400 invalid_input to comes after from');
  assert.equal(mapped(new ConnectorError('Mastodon', 'edit: 422 Text is too long', 422)), '502 upstream Mastodon: edit: 422 Text is too long');
  assert.equal(mapped(new SettingMissing('launchesRepo')), `409 refused ${new SettingMissing('launchesRepo').message}`);
  const teapot = new ApiError(415, 'unsupported_media_type', 'send JSON');
  assert.equal(apiErrorOf(teapot), teapot, 'an ApiError is answered as it is');
});

test('a bug is a 500 that keeps its words for the log', () => {
  const answer = apiErrorOf(new Error('the keychain is locked'));
  assert.equal(answer.status, 500);
  assert.equal(answer.internal, true);
  assert.doesNotMatch(answer.message, /keychain/);
});

test('a server function hands the owner what they can act on, and lets a bug through as it was', async () => {
  await assert.rejects(forOwner(async () => { throw new CommentRefused('invalid', 'no draft yet'); }), (e: unknown) => e instanceof InvalidInput && e.message === 'no draft yet');
  const bug = new TypeError('x is undefined');
  await assert.rejects(forOwner(async () => { throw bug; }), (e: unknown) => e === bug);
  assert.equal(await forOwner(async () => 3), 3);
});

test('an answer given as data names the reason by the error’s code', () => {
  assert.equal(reasonOf(new PostRefused('unsupported', 'x')), 'unsupported');
  assert.equal(reasonOf(new InvalidInput('x')), 'invalid');
  assert.equal(reasonOf(new ConnectorError('Mastodon', 'x', 500)), 'upstream');
  assert.equal(reasonOf(new Error('x')), 'failed');
});
