import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHANNEL_ADAPTERS, dryPublishing } from '../src/index.ts';

test('every channel has a dry publisher or strategy, and a call on one is recorded and refused', async () => {
  const dry = dryPublishing();
  for (const adapter of CHANNEL_ADAPTERS) {
    const id = adapter.definition.id;
    assert.ok(id in dry.publishers || id in dry.strategies, `${id} is wired`);
  }
  const bluesky = dry.publishers.bluesky!;
  await assert.rejects(async () => bluesky.publish({ text: 'hello', lang: 'en' }), /dry run: bluesky/);
  assert.ok(dry.calls.some((call) => call.startsWith('bluesky ')), dry.calls.join(', '));
});
