import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { SiteCapture } from '@shipcast/capture';
import { Brand, ContentPack, LaunchConfig, parseProjects } from '@shipcast/schema';
import { buildAssets, carouselPieces, mediaPath } from '../src/index.ts';
import { memoryRegistry } from '../src/testing.ts';

const brand = Brand.parse({ id: 'personal', displayName: 'José Antonio Garrido', site: 'https://josegarrido.dev', github: 'yeyo11' });
const launch = (await (await memoryRegistry()).launches.claim({ repo: 'yeyo11/claudio', ref: 'v0.8.2', trigger: 'release', kind: 'launch', brand: 'personal' })).launch;
const pack = ContentPack.parse({
  schemaVersion: 1,
  kind: 'launch',
  project: { name: 'claudio', repo: 'https://github.com/yeyo11/claudio', version: 'v0.8.2' },
  analysis: { summary: 'Claude Code as a service.', implemented: ['x'], planned: [], documentedOnly: [], limitations: [] },
  article: { en: { slug: 'claudio', title: 't', description: 'Run Claude Code from anywhere.', markdown: 'b' } },
});
const withInstagram = ContentPack.parse({
  ...pack,
  instagram: {
    caption: 'claudio. Link in bio. #claudecode',
    summary: 'Claude Code as a service.',
    slides: [
      { title: 'Chats from anywhere', text: 'From a browser, a phone or curl.' },
      { title: 'Agents in parallel', text: 'Each in its own worktree.' },
    ],
  },
});
/** The site has no drawn cover for the project: the house illustration stands in */
/** claudio has a drawn cover in projects.yml: nothing to generate */
const PROJECTS_YML = '# looks\nclaudio:\n  colour: "#2FD7A0"\n  motif: phone\n  cover: /covers/claudio.jpg\n';
const listed = (() => {
  const parsed = parseProjects(PROJECTS_YML);
  if (!parsed.ok) throw new Error('fixture');
  return parsed.value;
})();
const noCover = (async () => new Response(null, { status: 404 })) as typeof fetch;

function withRepo(fn: (repo: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const repo = mkdtempSync(join(tmpdir(), 'shipcast-assets-'));
    try {
      await fn(repo);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  };
}

test(
  'without an Instagram piece, the launch gets its OG image as PNG and JPEG under public/',
  withRepo(async (repo) => {
    const built = await buildAssets({ projects: listed, pack, launch, config: LaunchConfig.parse({ enabled: true, brand: 'personal' }), brand, checkout: { hostPath: repo, providerPath: '/w' } });
    assert.ok(built.ok);
    assert.deepEqual(
      built.files.map((f) => f.path),
      ['public/launches/claudio/v0.8.2/og.png', 'public/launches/claudio/v0.8.2/og.jpg'],
    );
    assert.deepEqual(built.media, { ogPng: '/launches/claudio/v0.8.2/og.png', ogJpeg: '/launches/claudio/v0.8.2/og.jpg' });
    assert.equal(mediaPath(launch, 'og.jpg'), '/launches/claudio/v0.8.2/og.jpg');
  }),
);

test(
  'a demo named in launch.yml but missing from the repo stops the launch',
  withRepo(async (repo) => {
    const config = LaunchConfig.parse({ enabled: true, brand: 'personal', assets: { demo: 'docs/media/tour.gif' } });
    const built = await buildAssets({ projects: listed, pack: withInstagram, fetch: noCover, launch, config, brand, checkout: { hostPath: repo, providerPath: '/w' } });
    assert.deepEqual(built, { ok: false, problem: 'launch.yml names the demo docs/media/tour.gif, which is not in the repository at v0.8.2' });
  }),
);

test(
  'a demo path that climbs out of the clone is refused',
  withRepo(async (repo) => {
    const config = LaunchConfig.parse({ enabled: true, brand: 'personal', assets: { demo: '../../etc/passwd' } });
    const built = await buildAssets({ projects: listed, pack: withInstagram, fetch: noCover, launch, config, brand, checkout: { hostPath: repo, providerPath: '/w' } });
    assert.equal(built.ok, false);
  }),
);

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

test('the carousel is the cover, the demo when there is one, one slide per feature and the closing slide', () => {
  const withDemo = LaunchConfig.parse({ enabled: true, brand: 'personal', assets: { demo: 'docs/media/tour.gif' } });
  assert.deepEqual(carouselPieces(withInstagram, withDemo).map((p) => `${p.file}:${p.kind}`), [
    'instagram-01.jpg:image',
    'instagram-02.mp4:video',
    'instagram-03.jpg:image',
    'instagram-04.jpg:image',
    'instagram-05.jpg:image',
  ]);
  assert.equal(carouselPieces(withInstagram, LaunchConfig.parse({ enabled: true, brand: 'personal' })).length, 4, 'no demo, no video');
  assert.deepEqual(carouselPieces(pack, withDemo), [], 'no Instagram piece, no carousel');
});

test(
  'the carousel and its story are drawn into the drafts, the demo as a video',
  { skip: !hasFfmpeg && 'ffmpeg not installed' },
  withRepo(async (repo) => {
    mkdirSync(join(repo, 'docs/media'), { recursive: true });
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10', '-t', '1', join(repo, 'docs/media/tour.gif')]);
    const config = LaunchConfig.parse({ enabled: true, brand: 'personal', assets: { demo: 'docs/media/tour.gif' } });
    const built = await buildAssets({ projects: listed, pack: withInstagram, launch, config, brand, fetch: noCover, checkout: { hostPath: repo, providerPath: '/w' } });
    assert.ok(built.ok);
    const dir = 'public/launches/claudio/v0.8.2';
    assert.deepEqual(built.files.map((f) => f.path).sort(), [
      `${dir}/instagram-01.jpg`,
      `${dir}/instagram-02.mp4`,
      `${dir}/instagram-03.jpg`,
      `${dir}/instagram-04.jpg`,
      `${dir}/instagram-05.jpg`,
      `${dir}/instagram-story.jpg`,
      `${dir}/og.jpg`,
      `${dir}/og.png`,
    ]);
    const video = built.files.find((f) => f.path.endsWith('instagram-02.mp4'));
    assert.ok(video && 'bytes' in video && video.bytes.length > 1000);
  }),
);

test(
  'a project with no cover anywhere gets one generated, and projects.yml pointing to it',
  withRepo(async (repo) => {
    const config = LaunchConfig.parse({ enabled: true, brand: 'personal' });
    const built = await buildAssets({ pack, launch, config, brand, fetch: noCover, projectsText: PROJECTS_YML.replace('claudio', 'other'), projects: {}, checkout: { hostPath: repo, providerPath: '/w' } });
    assert.ok(built.ok);
    const cover = built.files.find((f) => f.path === 'public/covers/claudio.jpg');
    assert.ok(cover && 'bytes' in cover && cover.bytes.length > 5_000);
    const yml = built.files.find((f) => f.path === 'projects.yml');
    assert.ok(yml && 'content' in yml);
    const parsed = parseProjects(yml.content);
    assert.ok(parsed.ok);
    assert.equal(parsed.value.claudio?.cover, '/covers/claudio.jpg');
    assert.ok(parsed.value.other, 'the file keeps its other projects');
    assert.match(yml.content, /^# looks/, 'and its comments');
  }),
);

test(
  'a cover the site already serves is not drawn again, and the Instagram cover is that one',
  withRepo(async (repo) => {
    const config = LaunchConfig.parse({ enabled: true, brand: 'personal' });
    const served = (async () => new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), { headers: { 'content-type': 'image/jpeg' } })) as typeof fetch;
    const built = await buildAssets({ pack, launch, config, brand, fetch: served, projects: {}, checkout: { hostPath: repo, providerPath: '/w' } });
    assert.ok(built.ok);
    assert.ok(!built.files.some((f) => f.path.startsWith('public/covers/')));
    assert.ok(built.files.some((f) => f.path === 'projects.yml'), 'but projects.yml learns where it is');
  }),
);

test(
  'a project that has its cover in projects.yml gets neither a cover nor a projects.yml change',
  withRepo(async (repo) => {
    const config = LaunchConfig.parse({ enabled: true, brand: 'personal' });
    const built = await buildAssets({ pack, launch, config, brand, projects: listed, checkout: { hostPath: repo, providerPath: '/w' } });
    assert.ok(built.ok);
    assert.ok(!built.files.some((f) => f.path === 'projects.yml' || f.path.startsWith('public/covers/')));
  }),
);

/** A capture that never opens a browser: one page's worth of PNG bytes and a GIF */
function fakeCapture(options: { failScreenshots?: boolean; failTour?: boolean } = {}) {
  const calls: string[] = [];
  const capture: SiteCapture = {
    async screenshots(site, pages) {
      calls.push(`screenshots ${site} ${pages?.length ?? 0}`);
      if (options.failScreenshots) throw new Error('Chromium for Playwright is not installed: run `npx playwright install chromium`');
      return [
        { name: 'home', viewport: 'desktop', png: new Uint8Array([1]) },
        { name: 'home', viewport: 'mobile', png: new Uint8Array([2]) },
      ];
    },
    async tour(site) {
      calls.push(`tour ${site}`);
      if (options.failTour) throw new Error('ffmpeg is not on PATH');
      return { gif: new Uint8Array([71, 73, 70]), seconds: 8 };
    },
  };
  return { capture, calls };
}

test(
  'assets.site adds the screenshots and, with no demo, the recorded tour as demo.gif',
  withRepo(async (repo) => {
    const { capture, calls } = fakeCapture();
    const config = LaunchConfig.parse({ enabled: true, brand: 'personal', assets: { site: 'https://claudio.example' } });
    const built = await buildAssets({ projects: listed, pack, launch, config, brand, capture, checkout: { hostPath: repo, providerPath: '/w' } });
    assert.ok(built.ok);
    const dir = 'public/launches/claudio/v0.8.2';
    const paths = built.files.map((f) => f.path);
    assert.ok(paths.includes(`${dir}/screenshots/home-desktop.png`));
    assert.ok(paths.includes(`${dir}/screenshots/home-mobile.png`));
    assert.ok(paths.includes(`${dir}/demo.gif`));
    assert.deepEqual(calls, ['screenshots https://claudio.example 0', 'tour https://claudio.example']);
  }),
);

test(
  'a committed demo is not replaced by a recording',
  withRepo(async (repo) => {
    const { capture, calls } = fakeCapture();
    const config = LaunchConfig.parse({ enabled: true, brand: 'personal', assets: { site: 'https://claudio.example', demo: 'docs/tour.gif' } });
    const built = await buildAssets({ projects: listed, pack, launch, config, brand, capture, checkout: { hostPath: repo, providerPath: '/w' } });
    assert.ok(built.ok);
    assert.deepEqual(calls, ['screenshots https://claudio.example 0']);
    assert.ok(!built.files.some((f) => f.path.endsWith('demo.gif')));
  }),
);

test(
  'a capture that fails stops the launch with a sentence',
  withRepo(async (repo) => {
    const config = LaunchConfig.parse({ enabled: true, brand: 'personal', assets: { site: 'https://claudio.example' } });
    for (const failing of [{ failScreenshots: true }, { failTour: true }]) {
      const built = await buildAssets({ projects: listed, pack, launch, config, brand, capture: fakeCapture(failing).capture, checkout: { hostPath: repo, providerPath: '/w' } });
      assert.equal(built.ok, false);
      assert.match(!built.ok ? built.problem : '', /^could not capture https:\/\/claudio\.example: /);
    }
  }),
);

test('a site alone puts the demo video in the carousel', () => {
  const config = LaunchConfig.parse({ enabled: true, brand: 'personal', assets: { site: 'https://claudio.example' } });
  assert.equal(carouselPieces(withInstagram, config)[1]?.kind, 'video');
});

test(
  'the recorded GIF feeds the Instagram demo video like a committed one',
  { skip: !hasFfmpeg && 'ffmpeg not installed' },
  withRepo(async (repo) => {
    const gif = join(repo, 'tour.gif');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10', '-t', '1', gif]);
    const bytes = new Uint8Array(readFileSync(gif));
    const capture: SiteCapture = { screenshots: async () => [], tour: async () => ({ gif: bytes, seconds: 1 }) };
    const config = LaunchConfig.parse({ enabled: true, brand: 'personal', assets: { site: 'https://claudio.example' } });
    const built = await buildAssets({ projects: listed, pack: withInstagram, launch, config, brand, capture, fetch: noCover, checkout: { hostPath: repo, providerPath: '/w' } });
    assert.ok(built.ok);
    const video = built.files.find((f) => f.path.endsWith('instagram-02.mp4'));
    assert.ok(video && 'bytes' in video && video.bytes.length > 1000);
  }),
);
