import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BROWSER_MISSING, defaultTour, gifArgs, isBrowserMissing, MAX_TOUR_SECONDS, pageName, pageUrl, planScreenshots, planTour } from '../src/index.ts';

const SITE = 'https://claudio.example';

test('with no steps the tour is the default: a pause, a slow scroll to the bottom and back to the top', () => {
  const plan = planTour(SITE, undefined);
  assert.deepEqual(plan, defaultTour());
  assert.deepEqual(planTour(SITE, []), plan);
  assert.deepEqual(plan[0], { wait: 1500 });
  assert.ok(plan.some((s) => 'scroll' in s && s.scroll === 'bottom'));
  assert.ok(plan.some((s) => 'scroll' in s && typeof s.scroll === 'number' && s.scroll < 0));
});

test('given steps are kept; a tour over 12 steps or one that leaves the site is refused', () => {
  assert.deepEqual(planTour(SITE, [{ click: '#go' }, { goto: '/docs' }]), [{ click: '#go' }, { goto: '/docs' }]);
  assert.throws(() => planTour(SITE, Array.from({ length: 13 }, () => ({ wait: 100 }))), /at most 12/);
  assert.throws(() => planTour(SITE, [{ goto: '//elsewhere.example/x' }]), /leaves/);
});

test('page URLs stay on the site', () => {
  assert.equal(pageUrl(SITE, '/docs?a=1'), 'https://claudio.example/docs?a=1');
  assert.throws(() => pageUrl(SITE, 'https://elsewhere.example/'), /leaves/);
});

test('screenshot names come from the path, are unique, and default to the root', () => {
  assert.equal(pageName({ path: '/' }), 'home');
  assert.equal(pageName({ path: '/docs/Getting_Started/?x=1' }), 'docs-getting-started');
  assert.equal(pageName({ path: '/x', name: 'custom' }), 'custom');
  assert.deepEqual(planScreenshots(undefined), [{ name: 'home', path: '/' }]);
  assert.deepEqual(planScreenshots([{ path: '/a' }, { path: '/a/' }, { path: '/' }]).map((p) => p.name), ['a', 'a-2', 'home']);
});

test('the GIF is cut at 20 s, 12 fps, 960 wide, with one palette for the clip', () => {
  const args = gifArgs('in.webm', 'out.gif');
  assert.equal(args[args.indexOf('-t') + 1], String(MAX_TOUR_SECONDS));
  const filter = args[args.indexOf('-filter_complex') + 1]!;
  assert.match(filter, /fps=12,scale=960:-1/);
  assert.match(filter, /palettegen/);
  assert.match(filter, /paletteuse/);
  assert.equal(args.at(-1), 'out.gif');
});

test("a missing browser is recognised from Playwright's error", () => {
  assert.equal(isBrowserMissing(new Error("browserType.launch: Executable doesn't exist at /x/chrome\nRun npx playwright install")), true);
  assert.equal(isBrowserMissing(new Error('boom')), false);
  assert.match(BROWSER_MISSING, /npx playwright install chromium/);
});
