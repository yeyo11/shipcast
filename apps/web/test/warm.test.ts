import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { lazyChunks, warm } from '../src/server/warm.ts';

/** A server build in miniature: the entry loads the router and a server function, the router loads a route, the route loads a browser-only chunk */
function build(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'shipcast-warm-'));
  mkdirSync(join(dir, 'assets'));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

const base = {
  'server.js': 'export default { fetch: () => [import("./assets/router-A1.js"), import("./assets/launches.functions-B2.js")] };',
  'assets/router-A1.js': 'globalThis.warmed?.push("router"); export const routes = () => import("./_id-C3.js");',
  'assets/launches.functions-B2.js': 'globalThis.warmed?.push("functions");',
  'assets/_id-C3.js': 'globalThis.warmed?.push("route"); export const Tour = () => import("./TourRuntime-D4.js");',
  'assets/TourRuntime-D4.js': 'throw new Error("browser only");',
};

test('the chunks to warm are the entry’s lazy ones and the router’s, not a route’s own', async () => {
  const dir = build(base);
  const chunks = (await lazyChunks(dir)).map((f) => f.slice(dir.length + 1)).sort();
  assert.deepEqual(chunks, ['assets/_id-C3.js', 'assets/launches.functions-B2.js', 'assets/router-A1.js']);
});

test('warming loads them and is ready once it has', async () => {
  const dir = build(base);
  const warmed: string[] = [];
  (globalThis as { warmed?: string[] }).warmed = warmed;
  const logs: string[] = [];
  const warmth = warm(dir, 5_000, (line) => logs.push(line));
  assert.equal(warmth.ready(), false);
  await warmth.done;
  assert.equal(warmth.ready(), true);
  assert.deepEqual(warmed.sort(), ['functions', 'route', 'router']);
  assert.deepEqual(logs, []);
  delete (globalThis as { warmed?: string[] }).warmed;
});

test('a chunk that fails is reported and does not keep the process from being ready', async () => {
  const dir = build({ ...base, 'assets/launches.functions-B2.js': 'throw new Error("no registry");' });
  const logs: string[] = [];
  const warmth = warm(dir, 5_000, (line) => logs.push(line));
  await warmth.done;
  assert.equal(warmth.ready(), true);
  assert.equal(logs.length, 1);
  assert.match(logs[0] ?? '', /launches\.functions-B2\.js: no registry/);
});

test('a warm-up that never finishes stops holding readiness after its timeout', async () => {
  const dir = build({ ...base, 'assets/_id-C3.js': 'await new Promise(() => undefined);' });
  const logs: string[] = [];
  const warmth = warm(dir, 50, (line) => logs.push(line));
  await warmth.done;
  assert.equal(warmth.ready(), true);
  assert.match(logs.join('\n'), /still loading after 50 ms; ready anyway/);
});

test('a build without the entry warms nothing and is ready', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shipcast-warm-'));
  const logs: string[] = [];
  const warmth = warm(dir, 5_000, (line) => logs.push(line));
  await warmth.done;
  assert.equal(warmth.ready(), true);
  assert.match(logs.join('\n'), /warm-up failed/);
});
