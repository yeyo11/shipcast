import assert from 'node:assert/strict';
import { test } from 'node:test';
import { run } from '../src/secrets.ts';

test('a tool that exits before reading its input answers with its exit code, not an EPIPE', async () => {
  // More than a pipe's buffer, so the write is still pending when the tool exits
  const result = await run('false', [], 'x'.repeat(4 * 1024 * 1024));
  assert.equal(result.code, 1);
});
