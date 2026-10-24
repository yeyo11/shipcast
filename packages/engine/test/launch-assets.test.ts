import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Brand, ContentPack, LaunchConfig } from '@shipcast/schema';
import { buildAssets, carouselPieces, mediaPath, Registry } from '../src/index.ts';

const brand = Brand.parse({ id: 'personal', displayName: 'José Antonio Garrido', site: 'https://josegarrido.dev', github: 'yeyo11' });
const launch = new Registry(':memory:').claim({ repo: 'yeyo11/claudio', ref: 'v0.8.2', trigger: 'release', kind: 'launch', brand: 'personal' }).launch;
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
    const built = await buildAssets({ pack, launch, config: LaunchConfig.parse({ enabled: true, brand: 'personal' }), brand, checkout: { hostPath: repo, providerPath: '/w' } });
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
    const built = await buildAssets({ pack: withInstagram, fetch: noCover, launch, config, brand, checkout: { hostPath: repo, providerPath: '/w' } });
    assert.deepEqual(built, { ok: false, problem: 'launch.yml names the demo docs/media/tour.gif, which is not in the repository at v0.8.2' });
  }),
);

test(
  'a demo path that climbs out of the clone is refused',
  withRepo(async (repo) => {
    const config = LaunchConfig.parse({ enabled: true, brand: 'personal', assets: { demo: '../../etc/passwd' } });
    const built = await buildAssets({ pack: withInstagram, fetch: noCover, launch, config, brand, checkout: { hostPath: repo, providerPath: '/w' } });
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
    const built = await buildAssets({ pack: withInstagram, launch, config, brand, fetch: noCover, checkout: { hostPath: repo, providerPath: '/w' } });
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
