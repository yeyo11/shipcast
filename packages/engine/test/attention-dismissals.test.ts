import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryRegistry } from '../src/testing.ts';

test('dismissed keys are remembered, once, and only those asked about come back', async () => {
  const registry = await memoryRegistry();
  await registry.dismissAttention(['launch:1:waiting:a', 'launch:1:waiting:a', 'account:3:reconnect:x']);
  await registry.dismissAttention([]);
  assert.deepEqual([...(await registry.dismissedAttention(['launch:1:waiting:a', 'launch:2:waiting:b']))], ['launch:1:waiting:a']);
  assert.deepEqual([...(await registry.dismissedAttention([]))], []);
});

test('clearing keeps the dismissals of the lines still there and forgets the rest', async () => {
  const registry = await memoryRegistry();
  await registry.dismissAttention(['a', 'b', 'c']);
  assert.equal(await registry.clearAttentionDismissals(['b', 'z']), 2);
  assert.deepEqual([...(await registry.dismissedAttention(['a', 'b', 'c']))], ['b']);
  assert.equal(await registry.clearAttentionDismissals(), 1);
  assert.equal((await registry.dismissedAttention(['b'])).size, 0);
});

test('with no comment waiting there is no newest one', async () => {
  const registry = await memoryRegistry();
  assert.equal(await registry.comments.newestWaitingCommentId(), null);
});
