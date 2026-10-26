import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NETWORKS } from '@shipcast/runtime';
import { groupOf, readGroup } from '../src/server/network-groups.ts';

test('every network lands in the tab for what it does', () => {
  const group = (id: string) => groupOf(NETWORKS.find((n) => n.id === id)!);
  assert.equal(group('mastodon'), 'social');
  assert.equal(group('threads'), 'social');
  assert.equal(group('devto'), 'blog');
  assert.equal(group('hashnode'), 'blog');
  assert.equal(group('brevo'), 'blog');
  assert.equal(group('cloudflare'), 'measurement');
  assert.equal(group('searchConsole'), 'measurement');
  assert.equal(group('anthropic'), 'ai');
  assert.equal(group('openaiCompatible'), 'ai');
});

test('the address only names a tab that exists', () => {
  assert.equal(readGroup('blog'), 'blog');
  assert.equal(readGroup('nope'), undefined);
  assert.equal(readGroup(undefined), undefined);
});
