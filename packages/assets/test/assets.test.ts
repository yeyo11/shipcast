import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import jpegJs from 'jpeg-js';
import { writeFileSync } from 'node:fs';
import { closingSlide, DEMO_WINDOW, demoOnBackdrop, demoSlide, durationSeconds, featureSlide, OG_HEIGHT, OG_WIDTH, COVER_HEIGHT, COVER_WIDTH, renderCover, renderIllustration, renderOgImage, renderSlide, SLIDE_HEIGHT, SLIDE_WIDTH } from '../src/index.ts';

const CLAUDIO = { colour: '#2FD7A0', motif: 'phone' } as const;

function pngSize(png: Uint8Array): { width: number; height: number } {
  const view = new DataView(png.buffer, png.byteOffset);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

test('the OG image renders at 1200x630, as PNG and as JPEG', async () => {
  const { png, jpeg } = await renderOgImage({
    project: 'claudio',
    look: CLAUDIO,
    title: 'claudio 0.8.2: Claude Code, now as a service',
    pitch: 'Claude Code as a service: a REST API, a web UI and a desktop app.',
    version: 'v0.8.2',
    author: 'José Antonio Garrido',
    site: 'josegarrido.dev',
  });
  assert.deepEqual([...png.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'a PNG');
  assert.deepEqual(pngSize(png), { width: OG_WIDTH, height: OG_HEIGHT });
  assert.deepEqual([...jpeg.slice(0, 3)], [0xff, 0xd8, 0xff], 'a JPEG');
  assert.ok(jpeg.length > 10_000 && jpeg.length < 1_000_000, 'a real image under Bluesky’s 1 MB blob limit');
});

test('a generated cover is a 1600x900 JPEG, one per look, with nothing else in it', async () => {
  const cover = await renderCover({ colour: '#FF7A2F', motif: 'stack' });
  assert.deepEqual([...cover.slice(0, 3)], [0xff, 0xd8, 0xff], 'a JPEG');
  const decoded = jpegJs.decode(cover, { useTArray: true });
  assert.deepEqual({ width: decoded.width, height: decoded.height }, { width: COVER_WIDTH, height: COVER_HEIGHT });
  assert.equal(COVER_WIDTH * 9, COVER_HEIGHT * 16);
  // The top-left corner is the project's flat colour under the pale halftone
  const at = (x: number, y: number) => [0, 1, 2].map((c) => decoded.data[(y * decoded.width + x) * 4 + c]);
  const [r, g, b] = at(COVER_WIDTH - 20, 20);
  assert.ok(Math.abs((r ?? 0) - 0xff) < 12 && Math.abs((g ?? 0) - 0x7a) < 12 && Math.abs((b ?? 0) - 0x2f) < 12, `the field is the colour, got ${r},${g},${b}`);
  assert.notDeepEqual([...cover], [...(await renderCover({ colour: '#7C8CFF', motif: 'orb' }))]);
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

test('a short demo GIF becomes a 3 s carousel video over its backdrop, 1080x1350 H.264 with an audio track', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shipcast-demo-'));
  try {
    const gif = join(dir, 'demo.gif');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=10', '-t', '1.2', gif]);
    const backdrop = join(dir, 'backdrop.png');
    writeFileSync(backdrop, (await renderSlide(demoSlide({ look: CLAUDIO, project: 'claudio', title: 'See it run', version: 'v0.9.0' }))).png);
    const mp4 = join(dir, 'demo.mp4');
    await demoOnBackdrop(gif, backdrop, DEMO_WINDOW, mp4);

    const probe = JSON.parse(
      execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', mp4], { encoding: 'utf8' }),
    ) as { streams: Array<{ codec_type: string; codec_name: string; width?: number; height?: number; pix_fmt?: string }> };
    const video = probe.streams.find((s) => s.codec_type === 'video')!;
    assert.equal(video.codec_name, 'h264');
    assert.equal(video.width, SLIDE_WIDTH);
    assert.equal(video.height, SLIDE_HEIGHT);
    assert.equal(video.pix_fmt, 'yuv420p');
    assert.ok(probe.streams.some((s) => s.codec_type === 'audio' && s.codec_name === 'aac'));
    const seconds = await durationSeconds(mp4);
    assert.ok(seconds >= 2.9 && seconds <= 3.3, `looped up to about 3 s, got ${seconds}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the carousel slides render at 4:5, and a project without a drawn cover gets the house illustration', async () => {
  const feature = await renderSlide(featureSlide({ look: CLAUDIO, project: 'claudio', index: 1, title: 'Chats from anywhere', text: 'From a browser, a phone or curl.' }));
  assert.deepEqual(pngSize(feature.png), { width: SLIDE_WIDTH, height: SLIDE_HEIGHT });
  assert.deepEqual([...feature.jpeg.slice(0, 3)], [0xff, 0xd8, 0xff], 'Instagram takes JPEG');
  const closing = await renderSlide(closingSlide({ look: CLAUDIO, project: 'claudio', text: 'The full write-up is in my bio', author: 'Me', site: 'example.dev' }));
  assert.deepEqual(pngSize(closing.png), { width: SLIDE_WIDTH, height: SLIDE_HEIGHT }, 'without a photo too');
  assert.deepEqual(pngSize(await renderIllustration({ colour: '#FF7A2F', motif: 'stack' })), { width: 1120, height: 1260 });
});
