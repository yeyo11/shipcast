import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loginPath, safeNext } from '../src/server/next-path.ts';

test('signing in again goes back to a page of the app, with its query', () => {
  assert.equal(safeNext('/launches/3?tab=channels&channel=devto'), '/launches/3?tab=channels&channel=devto');
  assert.equal(safeNext('/stats#posts'), '/stats#posts');
  assert.equal(loginPath('/onboarding'), '/login?next=%2Fonboarding');
});

test('never another site, the sign-in itself or what is not a page', () => {
  for (const bad of ['https://evil.example/x', '//evil.example', '/\\evil.example', 'javascript:alert(1)', 'stats', '/login?next=/x', '/auth/github', '/api/v1/launches', '/mcp', '/_serverFn/abc', '/', '/a\nb', '']) {
    assert.equal(safeNext(bad), undefined, bad);
  }
  assert.equal(safeNext(`/${'a'.repeat(3000)}`), undefined, 'too long');
  assert.equal(loginPath(undefined), '/login');
  assert.equal(loginPath('https://evil.example'), '/login');
});
