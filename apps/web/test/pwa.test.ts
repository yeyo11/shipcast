import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { webManifest } from '../src/pwa/manifest.ts';
import { appPath, notificationOf } from '../src/pwa/notification.ts';
import { offlinePage } from '../src/pwa/offline-page.ts';
import { deviceLabel, keyBytes, pushSupport } from '../src/pwa/push-client.ts';
import { cacheable, isSignOut, PRIVATE_PATHS, swStrategy, type SwStrategy } from '../src/pwa/rules.ts';

/* The installable app (docs/decisions/pwa.md): the service worker's rules, its notifications, the manifest */

const ORIGIN = 'https://shipcast.example.dev';
const rule = (path: string, init: { method?: string; mode?: string } = {}): SwStrategy =>
  swStrategy({ method: init.method ?? 'GET', mode: init.mode ?? 'cors', url: path.startsWith('http') ? path : `${ORIGIN}${path}`, origin: ORIGIN });

describe('what the service worker does with a request', () => {
  test('everything behind the session, and every auth and health door, goes to the network only, as a page or a fetch', () => {
    const privatePaths = [
      '/api/launches',
      '/api/events',
      '/api/v1/launches/3',
      '/api/v1/openapi.json',
      '/api/health',
      '/api/github/webhook',
      '/api/sources/media',
      '/api/assistant',
      '/mcp',
      '/media/12',
      '/uploads/abc123',
      '/avatars/4',
      '/auth/github',
      '/auth/github/callback',
      '/auth/logout',
      '/auth/link',
      '/login',
      '/login?next=%2F',
      '/livez',
      '/readyz',
      '/_serverFn/abc?createServerFn',
      '/sw.js',
      '/manifest.webmanifest',
    ];
    for (const path of privatePaths) {
      assert.equal(rule(path), 'network-only', path);
      assert.equal(rule(path, { mode: 'navigate' }), 'network-only', `${path} opened as a page`);
      assert.ok(
        PRIVATE_PATHS.some((p) => p.test(new URL(path, ORIGIN).pathname)),
        `${path} is on the private list`,
      );
    }
  });

  test('a page is never cached: the network, with the offline page when it fails', () => {
    for (const path of ['/', '/launches', '/launches/3', '/launches/3/edit', '/comments?state=waiting', '/settings/notifications', '/stats']) assert.equal(rule(path, { mode: 'navigate' }), 'navigate', path);
  });

  test('only the build’s public files are cached: hashed assets first from the cache, stable ones refreshed behind', () => {
    assert.equal(rule('/assets/index-gi8J8EYL.js'), 'cache-first');
    assert.equal(rule('/assets/kit-BCdi7EYf.css'), 'cache-first');
    for (const path of ['/tokens.css', '/fonts/inter-tight-latin-wght-normal.woff2', '/logo/mark.svg', '/pwa/icon-192.png', '/icons/bluesky.svg', '/offline.html']) assert.equal(rule(path), 'stale-while-revalidate', path);
    // Anything else, or a public file asked with a query, is not the worker's to keep
    for (const path of ['/specimen.html', '/tokens.json', '/README.md', '/scripts/contrast.mjs', '/tokens.css?v=2', '/assets/index.js?x=1', '/launches/3']) assert.equal(rule(path), 'network-only', path);
  });

  test('another origin and any method but GET are left to the browser', () => {
    assert.equal(rule('https://avatars.githubusercontent.com/u/1'), 'pass');
    assert.equal(rule('/assets/index-gi8J8EYL.js', { method: 'HEAD' }), 'pass');
    assert.equal(rule('/auth/logout', { method: 'POST', mode: 'navigate' }), 'pass');
    assert.equal(rule('/_serverFn/abc', { method: 'POST' }), 'pass');
    assert.equal(swStrategy({ method: 'GET', mode: 'cors', url: 'not a url', origin: ORIGIN }), 'pass');
  });

  test('the sign-out is seen, so the runtime cache is emptied with it', () => {
    assert.equal(isSignOut({ url: `${ORIGIN}/auth/logout`, method: 'POST', origin: ORIGIN }), true);
    assert.equal(isSignOut({ url: `https://elsewhere.example/auth/logout`, method: 'POST', origin: ORIGIN }), false);
    assert.equal(isSignOut({ url: `${ORIGIN}/auth/github`, method: 'GET', origin: ORIGIN }), false);
  });

  test('a response is stored only when whole, shared and cookie-free', () => {
    const response = (status: number, headers: Record<string, string> = {}, type = 'basic') => ({ ok: status < 300, status, type, headers: new Headers(headers) });
    assert.equal(cacheable(response(200, { 'cache-control': 'public, max-age=3600' })), true);
    assert.equal(cacheable(response(200, { 'cache-control': 'no-store' })), false);
    assert.equal(cacheable(response(200, { 'cache-control': 'private, max-age=60' })), false);
    assert.equal(cacheable(response(200, { 'set-cookie': 'sc_session=x' })), false);
    assert.equal(cacheable(response(206)), false);
    assert.equal(cacheable(response(404)), false);
    assert.equal(cacheable(response(200, {}, 'opaque')), false);
  });
});

describe('a push, as the worker shows it', () => {
  test('the payload’s words and its page; nothing else', () => {
    assert.deepEqual(notificationOf({ title: 'Drafts to review', body: 'claudio v0.9.0 waits.', url: '/launches/12', tag: 'launch-12', extra: 'x' }), { title: 'Drafts to review', body: 'claudio v0.9.0 waits.', url: '/launches/12', tag: 'launch-12' });
    assert.deepEqual(notificationOf(undefined), { title: 'Shipcast', body: '', tag: 'shipcast', url: '/' });
    assert.equal(notificationOf({ title: 'x'.repeat(500) }).title.length, 80);
  });

  test('a tap only ever opens a page of the app', () => {
    for (const bad of ['https://evil.example/', '//evil.example/x', '/\\evil.example', 'javascript:alert(1)', 42, null]) assert.equal(appPath(bad), '/', String(bad));
    assert.equal(appPath('/comments?state=waiting'), '/comments?state=waiting');
    assert.equal(appPath('/launches/3#channels'), '/launches/3#channels');
  });
});

describe('the manifest and the offline page', () => {
  test('installable: name, start, scope, standalone, the theme colours and the icons, any and maskable at 192 and 512', () => {
    const manifest = webManifest();
    assert.equal(manifest.name, 'Shipcast');
    assert.equal(manifest.start_url, '/launches');
    assert.equal(manifest.scope, '/');
    assert.equal(manifest.display, 'standalone');
    assert.equal(manifest.theme_color, '#141413');
    assert.equal(manifest.background_color, '#141413');
    for (const purpose of ['any', 'maskable']) for (const size of ['192x192', '512x512']) assert.ok(manifest.icons.some((i) => i.purpose === purpose && i.sizes === size), `${purpose} ${size}`);
    assert.deepEqual(
      manifest.shortcuts.map((s) => [s.name, s.url]),
      [
        ['Launches', '/launches'],
        ['Write', '/write'],
        ['Comments', '/comments'],
        ['Stats', '/stats'],
      ],
    );
    // Every icon it names is a committed file of the design folder, the app's public folder
    for (const icon of [...manifest.icons, ...manifest.shortcuts.flatMap((s) => s.icons)]) assert.ok(readFileSync(new URL(`../../../design${icon.src}`, import.meta.url)).length > 0, icon.src);
  });

  test('the theme colour is the tokens’ night ground', () => {
    const tokens = readFileSync(new URL('../../../design/tokens.css', import.meta.url), 'utf8');
    assert.match(tokens, new RegExp(`--sc-ground: ${webManifest().theme_color};`));
  });

  test('the offline page says so, links only what it is given and tries again on its own', () => {
    const html = offlinePage({ stylesheets: ['/tokens.css', '/assets/kit-a"b.css'], scene: '<svg></svg>', themeColor: '#141413' });
    assert.match(html, /<h1[^>]*>You're offline<\/h1>/);
    assert.match(html, /href="\/assets\/kit-a&quot;b\.css"/);
    assert.match(html, /addEventListener\('online', retry\)/);
    assert.ok(!/<script[^>]+src=/.test(html), 'no script to fetch');
  });
});

describe('the browser’s half of push', () => {
  const env = (userAgent: string, over: Partial<Parameters<typeof pushSupport>[0]> = {}) => ({ userAgent, standalone: false, hasPush: true, hasWorker: true, dev: false, ...over });
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
  const ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';

  test('iOS takes push only in the installed app; development has no worker', () => {
    assert.equal(pushSupport(env(IPHONE)), 'install-first');
    assert.equal(pushSupport(env(IPHONE, { standalone: true })), 'ok');
    assert.equal(pushSupport(env(ANDROID)), 'ok');
    assert.equal(pushSupport(env(ANDROID, { hasPush: false })), 'unsupported');
    assert.equal(pushSupport(env(ANDROID, { dev: true })), 'no-worker');
  });

  test('a device is named by its browser and system', () => {
    assert.equal(deviceLabel(IPHONE), 'Safari on iPhone');
    assert.equal(deviceLabel(ANDROID), 'Chrome on Android');
    assert.equal(deviceLabel('Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0'), 'Firefox on Linux');
    assert.equal(deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0'), 'Edge on Windows');
  });

  test('the VAPID key is decoded from base64url', () => {
    const key = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 255)]);
    assert.deepEqual(Buffer.from(keyBytes(key.toString('base64url'))), key);
  });
});
