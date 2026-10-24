import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Registry } from '@shipcast/engine';
import { renderDashboard, serveDashboard } from '../src/dashboard.ts';

function seeded(): Registry {
  const registry = new Registry(':memory:');
  const { launch } = registry.claim({ repo: 'yeyo11/claudio', ref: 'v0.8.2', trigger: 'release', kind: 'launch', brand: 'personal' });
  registry.setStatus(launch.id, 'published', 'https://github.com/yeyo11/launches/pull/3');
  registry.recordPost({ launchId: launch.id, channel: 'devto', url: 'https://dev.to/x', externalId: '42' });
  registry.recordMetrics(launch.id, 'devto', { views: 1310, reactions: 12 }, new Date('2026-10-30T00:00:00Z'));
  return registry;
}

test('each launch shows its status, where it went and its latest numbers', () => {
  const html = renderDashboard(seeded());
  assert.match(html, /yeyo11\/claudio<\/strong> v0\.8\.2/);
  assert.match(html, /<a href="https:\/\/dev\.to\/x">devto<\/a>/);
  assert.match(html, /<strong>devto<\/strong> reactions 12, views 1,310/);
  assert.match(html, /href="https:\/\/github\.com\/yeyo11\/launches\/pull\/3"/);
});

test('text from the registry is escaped', () => {
  const registry = new Registry(':memory:');
  registry.claim({ repo: 'a/<b>', ref: 'v1', trigger: 'manual', kind: 'launch', brand: 'personal' });
  assert.ok(renderDashboard(registry).includes('a/&lt;b&gt;'));
});

test('the server answers the page and the JSON, on loopback only', async () => {
  const server = serveDashboard(seeded(), 0);
  await new Promise((r) => server.once('listening', r));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  assert.equal(address.address, '127.0.0.1');
  const base = `http://127.0.0.1:${address.port}`;
  assert.match(await (await fetch(base)).text(), /Launches/);
  const data = (await (await fetch(`${base}/api/launches`)).json()) as Array<{ posts: unknown[] }>;
  assert.equal(data[0]?.posts.length, 1);
  assert.equal((await fetch(`${base}/nope`)).status, 404);
  await new Promise((r) => server.close(r));
});
