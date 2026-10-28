import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { chapterLines, durationSeconds, renderVideo, srtOf, VIDEO_SIZES } from '../src/index.ts';

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
