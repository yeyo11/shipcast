import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { chapterLines, DEMO_WINDOW, durationSeconds, mediaWindow, placeInWindow, renderVideo, srtOf, VIDEO_SIZES, type VideoFormat } from '../src/index.ts';

const LOOK = { colour: '#2FD7A0', motif: 'phone' } as const;
const hasFfmpeg = spawnSync('ffprobe', ['-version']).status === 0 && spawnSync('ffmpeg', ['-version']).status === 0;

function size(file: string): { width: number; height: number } {
  const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim();
  const [width, height] = out.split(',').map(Number);
  return { width: width!, height: height! };
}

test('subtitles as SRT and chapters as description lines', () => {
  assert.equal(srtOf([{ start: 0, end: 2.5, text: 'Hello' }, { start: 2.5, end: 61.25, text: 'Bye' }]), '1\n00:00:00,000 --> 00:00:02,500\nHello\n\n2\n00:00:02,500 --> 00:01:01,250\nBye\n');
  assert.equal(chapterLines([{ at: 0, title: 'What it is' }, { at: 75, title: 'How it works' }]), '0:00 What it is\n1:15 How it works');
});

test('a script that cannot fit is refused before anything is rendered', async () => {
  const scenes = [{ kind: 'card' as const, title: 'Too long', subtitle: 'x', seconds: 70 }];
  await assert.rejects(renderVideo({ format: 'short', look: LOOK, author: 'José Antonio Garrido', site: 'josegarrido.dev', scenes, output: '/nonexistent/x.mp4' }), /at most 59 s/);
  await assert.rejects(renderVideo({ format: 'horizontal', look: LOOK, author: 'A', site: 's', scenes: [{ ...scenes[0]!, seconds: 10 }], output: '/nonexistent/x.mp4' }), /60 to 180 s/);
});

test('a Short renders at 1080x1920 with its subtitles, scene by scene', { skip: hasFfmpeg ? false : 'ffmpeg and ffprobe are not installed' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yt-test-'));
  try {
    const demo = join(dir, 'demo.mp4');
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30', '-t', '3', '-pix_fmt', 'yuv420p', demo]);
    const output = join(dir, 'short.mp4');
    const rendered = await renderVideo({
      format: 'short',
      look: LOOK,
      project: 'claudio',
      version: 'v0.8.2',
      author: 'José Antonio Garrido',
      site: 'josegarrido.dev',
      output,
      scenes: [
        { kind: 'card', title: 'Claude Code as a service', subtitle: 'claudio runs Claude Code behind an API', seconds: 2, chapter: 'What it is' },
        { kind: 'demo', file: demo, subtitle: 'Send a prompt, get the diff', maxSeconds: 10, chapter: 'Demo' },
      ],
    });
    assert.deepEqual(size(output), VIDEO_SIZES.short);
    assert.ok(Math.abs((await durationSeconds(output)) - 5) < 0.5, 'two seconds of card and three of demo');
    assert.equal(rendered.seconds, 5);
    assert.match(rendered.srt, /00:00:02,000 --> 00:00:05,000\nSend a prompt, get the diff/);
    assert.deepEqual(rendered.chapters, [{ at: 0, title: 'What it is' }, { at: 2, title: 'Demo' }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** The colours of a video's frame at the given points, at a time, as [r, g, b] */
function pixels(file: string, at: number, format: VideoFormat, points: Array<[number, number]>): Array<[number, number, number]> {
  const { width } = VIDEO_SIZES[format];
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(at), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 64 * 1024 * 1024 });
  return points.map(([x, y]) => {
    const i = (y * width + x) * 3;
    return [raw[i]!, raw[i + 1]!, raw[i + 2]!];
  });
}

/** Whether a pixel is within a few levels of a colour: H.264 and a GIF's palette shift them a little */
const near = (pixel: [number, number, number], hex: string, tolerance = 40) =>
  [1, 3, 5].every((at, i) => Math.abs(pixel[i]! - parseInt(hex.slice(at, at + 2), 16)) <= tolerance);

const DEMO_BLUE = '#2050FF';

test('a demo is fitted by its own shape: the window around it is the backdrop, never black bars', () => {
  const window = mediaWindow('horizontal');
  assert.deepEqual(window, { x: 120, y: 270, width: 1680, height: 500 });
  // A 1280x800 GIF, as Shipcast's own tour: 800x500 in the middle, and the 440 px each side are the backdrop
  assert.deepEqual(placeInWindow(window, { width: 1280, height: 800 }), { x: 560, y: 270, width: 800, height: 500 });
  // A 4:5 video in a Short's window: as tall as the window, centred side to side, even sides
  assert.deepEqual(placeInWindow(mediaWindow('short'), { width: 1081, height: 1351 }), { x: 89, y: 420, width: 902, height: 1128 });
});

test('a GIF demo renders inside the horizontal frame, on the brand colour, with nothing black around it', { skip: hasFfmpeg ? false : 'ffmpeg and ffprobe are not installed', timeout: 300_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yt-gif-'));
  try {
    // A small 16:10 GIF, the shape of a screen recording, in a colour that is neither black nor the look's
    const gif = join(dir, 'demo.gif');
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=0x${DEMO_BLUE.slice(1)}:s=320x200:r=12`, '-t', '2', gif]);
    const output = join(dir, 'video.mp4');
    await renderVideo({
      format: 'horizontal', look: LOOK, project: 'Shipcast', version: 'v0.3.0', author: 'A', site: 's', output,
      scenes: [
        { kind: 'card', title: 'Shipcast', subtitle: 'What it is', seconds: 58 },
        { kind: 'demo', file: gif, subtitle: 'Launches wait for you', maxSeconds: 20, chapter: 'The redesigned app' },
      ],
    });
    const window = mediaWindow('horizontal');
    const place = placeInWindow(window, { width: 320, height: 200 });
    const middle = window.y + window.height / 2;
    const [centre, left, right] = pixels(output, 59, 'horizontal', [[place.x + place.width / 2, middle], [window.x + 40, middle], [window.x + window.width - 40, middle]]);
    assert.ok(near(centre!, DEMO_BLUE), `the demo is shown in the middle, got ${centre}`);
    assert.ok(near(left!, LOOK.colour), `left of the demo is the backdrop, not black: got ${left}`);
    assert.ok(near(right!, LOOK.colour), `right of the demo is the backdrop, not black: got ${right}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the carousel\'s framed demo is cropped to its window: the recording alone, not the slide between black bars', { skip: hasFfmpeg ? false : 'ffmpeg and ffprobe are not installed', timeout: 300_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yt-carousel-'));
  try {
    // instagram-02.mp4 as the carousel makes it: a 1080x1350 slide in another colour, the demo in DEMO_WINDOW
    const slide = join(dir, 'instagram-02.mp4');
    const w = DEMO_WINDOW;
    execFileSync('ffmpeg', [
      '-y', '-v', 'error',
      '-f', 'lavfi', '-i', 'color=c=0xFFD43B:s=1080x1350:r=30',
      '-f', 'lavfi', '-i', `color=c=0x${DEMO_BLUE.slice(1)}:s=${w.width}x${w.height}:r=30`,
      '-filter_complex', `[0][1]overlay=${w.x}:${w.y}`, '-t', '2', '-pix_fmt', 'yuv420p', slide,
    ]);
    for (const format of ['short', 'horizontal'] as const) {
      const output = join(dir, `${format}.mp4`);
      const lead = format === 'short' ? 1 : 58;
      await renderVideo({
        format, look: LOOK, project: 'Shipcast', version: 'v0.3.0', author: 'A', site: 's', output,
        scenes: [
          { kind: 'card', title: 'Shipcast', subtitle: 'What it is', seconds: lead },
          { kind: 'demo', file: slide, crop: DEMO_WINDOW, subtitle: 'Launches wait for you', maxSeconds: 14 },
        ],
      });
      const window = mediaWindow(format);
      const place = placeInWindow(window, DEMO_WINDOW);
      const inset = 12;
      const corners: Array<[number, number]> = [[place.x + inset, place.y + inset], [place.x + place.width - inset, place.y + place.height - inset]];
      const outside: Array<[number, number]> = format === 'short' ? [[window.x + window.width / 2, window.y + 20], [window.x + window.width / 2, window.y + window.height - 20]] : [[window.x + 40, window.y + window.height / 2], [window.x + window.width - 40, window.y + window.height / 2]];
      const found = pixels(output, lead + 1, format, [...corners, ...outside]);
      for (const pixel of found.slice(0, 2)) assert.ok(near(pixel, DEMO_BLUE), `${format}: the demo fills its place to the corners, no slide around it: got ${pixel}`);
      for (const pixel of found.slice(2)) assert.ok(near(pixel, LOOK.colour), `${format}: around the demo is the backdrop, not black: got ${pixel}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
