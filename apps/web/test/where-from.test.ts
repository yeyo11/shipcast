import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isOffline } from '../src/components/offline.ts';
import { expiredPath, safeWas, sectionOf, whereFrom } from '../src/components/where-from.ts';

test('the page a session ended on, in words: the section, then the page when its title names one', () => {
  assert.equal(whereFrom('/launches/4', 'yeyo11/pando · Shipcast'), 'Launches › yeyo11/pando');
  assert.equal(whereFrom('/launches/4?tab=channels'), 'Launches');
  assert.equal(whereFrom('/stats', 'Stats · Shipcast'), 'Stats');
  assert.equal(whereFrom('/settings/ai', 'Shipcast'), 'Settings');
  assert.equal(whereFrom('/nowhere', 'Something · Shipcast'), undefined);
  assert.equal(sectionOf('/sources'), 'Launches');
  assert.equal(sectionOf('/writer'), undefined);
  assert.ok(whereFrom('/write', `${'x'.repeat(200)} · Shipcast`)!.length <= 80);
});

test('the sign-in address after a session ends keeps the way back and says where it was', () => {
  assert.equal(expiredPath('/launches/4', 'yeyo11/pando · Shipcast'), '/login?next=%2Flaunches%2F4&was=Launches%20%E2%80%BA%20yeyo11%2Fpando');
  assert.equal(expiredPath('/', 'Launches · Shipcast'), '/login');
  assert.equal(expiredPath('https://evil.example/x', 'x'), '/login');
});

test('a `was` from the address is plain, short text or nothing', () => {
  assert.equal(safeWas('Launches › pando'), 'Launches › pando');
  assert.equal(safeWas('a\nb'), 'ab');
  assert.equal(safeWas('x'.repeat(81)), undefined);
  assert.equal(safeWas(3), undefined);
  assert.equal(safeWas('  '), undefined);
});

test('a failure is the connection when the browser is offline or the request never reached the server', () => {
  assert.equal(isOffline(new Error('anything'), false), true);
  assert.equal(isOffline(new TypeError('Failed to fetch'), true), true);
  assert.equal(isOffline(new TypeError('NetworkError when attempting to fetch resource.'), true), true);
  assert.equal(isOffline(new TypeError('Load failed'), true), true);
  assert.equal(isOffline(new Error('SHIPCAST_SECRET_KEY is not set'), true), false);
});
