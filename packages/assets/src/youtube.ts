import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Resvg } from '@resvg/resvg-js';
import satori from 'satori';
import { box, editorialFonts, el, headline, INK, MUTED, TEXT, type Look, type OgNode } from './og.ts';
import { durationSeconds } from './video.ts';

const run = promisify(execFile);

/** The two videos of a launch: a vertical Short and a horizontal video */
export type VideoFormat = 'short' | 'horizontal';

export const VIDEO_SIZES: Record<VideoFormat, { width: number; height: number }> = {
  short: { width: 1080, height: 1920 },
  horizontal: { width: 1920, height: 1080 },
};

/** YouTube treats a vertical video as a Short up to this long; the horizontal one is 1 to 3 minutes */
export const SHORT_MAX_SECONDS = 59;
export const HORIZONTAL_SECONDS = { min: 60, max: 180 } as const;

/**
 * One scene of a video, with the line said over it as the subtitle (no voice: the subtitle is
 * the narration). A card is the brand's look with a title and a few words; a demo is the project's
 * recording inside the frame; an image is a screenshot or the cover, fitted.
 */
export type Scene =
  | { kind: 'card'; title: string; text?: string; subtitle: string; seconds: number; chapter?: string }
  | { kind: 'demo'; file: string; subtitle: string; maxSeconds: number; chapter?: string }
  | { kind: 'image'; image: { bytes: Uint8Array; mimeType: 'image/png' | 'image/jpeg' }; subtitle: string; seconds: number; chapter?: string };

export interface VideoRequest {
  format: VideoFormat;
  look: Look;
  project?: string;
  version?: string;
  author: string;
  site: string;
  scenes: Scene[];
  output: string;
  ffmpeg?: string;
  ffprobe?: string;
}

export interface RenderedVideo {
  seconds: number;
  /** The same subtitles as an SRT track, for YouTube's captions beside the burned-in ones */
  srt: string;
  /** Where each scene that names a chapter starts, for the description's chapter list */
  chapters: Array<{ at: number; title: string }>;
}

const SUBTITLE_BAND = { short: 300, horizontal: 190 } as const;

/** The subtitle as it is burned in: white on a black band at the bottom, in the house sans */
function subtitleBand(format: VideoFormat, text: string): OgNode {
  const { width } = VIDEO_SIZES[format];
  const height = SUBTITLE_BAND[format];
  return box(
    { position: 'absolute', left: 0, bottom: 0, width, height, background: INK, alignItems: 'center', justifyContent: 'center', padding: format === 'short' ? '0 72px' : '0 160px' },
    [box({ fontFamily: 'Instrument Sans', fontSize: format === 'short' ? 52 : 46, color: TEXT, textAlign: 'center', lineHeight: 1.25, justifyContent: 'center' }, text)],
  );
}

/** A scene's frame: the card or a backdrop with a window for the demo or image, and its subtitle */
function frame(request: VideoRequest, scene: Scene): { node: OgNode; window: { x: number; y: number; width: number; height: number } } {
  const { width, height } = VIDEO_SIZES[request.format];
  const band = SUBTITLE_BAND[request.format];
  const short = request.format === 'short';
  const margin = short ? 72 : 120;
  const eyebrow = [request.project, request.version].filter(Boolean).join(' ');
  const top = short ? 220 : 120;
  const window = { x: margin, y: top + (short ? 200 : 150), width: width - margin * 2, height: height - band - top - (short ? 200 : 150) - margin };
  const header = [
    ...(eyebrow ? [box({ fontFamily: 'Instrument Sans', fontSize: short ? 44 : 36, color: INK, marginBottom: 18 }, eyebrow)] : []),
    ...(scene.kind === 'card' ? [] : [headline(scene.chapter ?? request.project ?? '', { fontSize: short ? 72 : 60, color: INK })]),
  ];
  const children: OgNode[] =
    scene.kind === 'card'
      ? [
          box({ position: 'absolute', left: margin, top, width: width - margin * 2, flexDirection: 'column' }, [
            ...header,
            headline(scene.title, { fontSize: short ? 104 : 96, color: INK, lineHeight: 1.05 }),
            ...(scene.text ? [box({ fontFamily: 'Instrument Sans', fontSize: short ? 50 : 44, color: INK, marginTop: 40, lineHeight: 1.3 }, scene.text)] : []),
          ]),
        ]
      : [box({ position: 'absolute', left: margin, top, flexDirection: 'column' }, header), box({ position: 'absolute', left: window.x, top: window.y, width: window.width, height: window.height, background: INK })];
  const footer = box({ position: 'absolute', right: margin, bottom: band + 32, fontFamily: 'Instrument Sans', fontSize: short ? 34 : 28, color: INK }, [el('span', {}, `${request.author} · ${request.site}`)]);
  return {
    node: box({ width, height, background: request.look.colour, position: 'relative', color: MUTED }, [...children, footer, subtitleBand(request.format, scene.subtitle)]),
    window,
  };
}

async function png(node: OgNode, width: number, height: number): Promise<Uint8Array> {
  const svg = await satori(node as never, { width, height, fonts: await editorialFonts() });
  return new Uint8Array(new Resvg(svg, { fitTo: { mode: 'width', value: width } }).render().asPng());
}

/** H.264 yuv420p at 30 fps with a silent AAC track: the same encoding for every scene, so they concatenate as they are */
const ENCODE = ['-r', '30', '-c:v', 'libx264', '-preset', 'medium', '-crf', '21', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '64k', '-ar', '44100', '-ac', '2'];
const SILENCE = ['-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100'];

const timestamp = (seconds: number) => {
  const ms = Math.round(seconds * 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
};

/** Subtitle cues as SRT: one numbered cue per scene, from its start to its end */
export function srtOf(cues: Array<{ start: number; end: number; text: string }>): string {
  return cues.map((c, i) => `${i + 1}\n${timestamp(c.start)} --> ${timestamp(c.end)}\n${c.text}\n`).join('\n');
}

/** `0:00 Title` lines for a YouTube description; YouTube shows chapters when the first starts at 0:00 and there are three or more */
export function chapterLines(chapters: Array<{ at: number; title: string }>): string {
  const at = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  return chapters.map((c) => `${at(c.at)} ${c.title}`).join('\n');
}

/**
 * Renders a video from its scenes: each scene a clip of its own (a frame drawn with the brand's
 * fonts and colour, the demo or image fitted into its window, the subtitle burned in on a band), then
 * the clips joined without re-encoding, `faststart` so it streams. No voice and no music. A Short
 * longer than YouTube's limit, or a horizontal video outside one to three minutes, is refused before
 * anything is rendered from a script that cannot fit.
 */
export async function renderVideo(request: VideoRequest): Promise<RenderedVideo> {
  const ffmpeg = request.ffmpeg ?? 'ffmpeg';
  const { width, height } = VIDEO_SIZES[request.format];
  const lengths = await Promise.all(request.scenes.map(async (s) => (s.kind === 'demo' ? Math.min(await durationSeconds(s.file, request.ffprobe), s.maxSeconds) : s.seconds)));
  const total = lengths.reduce((sum, n) => sum + n, 0);
  if (request.format === 'short' && total > SHORT_MAX_SECONDS) throw new Error(`a Short lasts at most ${SHORT_MAX_SECONDS} s; these scenes last ${total.toFixed(1)} s`);
  if (request.format === 'horizontal' && (total < HORIZONTAL_SECONDS.min || total > HORIZONTAL_SECONDS.max)) throw new Error(`the horizontal video lasts ${HORIZONTAL_SECONDS.min} to ${HORIZONTAL_SECONDS.max} s; these scenes last ${total.toFixed(1)} s`);

  const dir = await mkdtemp(join(tmpdir(), 'shipcast-video-'));
  try {
    const clips: string[] = [];
    for (const [i, scene] of request.scenes.entries()) {
      const seconds = lengths[i]!;
      const { node, window } = frame(request, scene);
      const still = join(dir, `frame-${i}.png`);
      await writeFile(still, await png(node, width, height));
      const clip = join(dir, `clip-${i}.mp4`);
      if (scene.kind === 'card') {
        await run(ffmpeg, ['-y', '-v', 'error', '-loop', '1', '-i', still, ...SILENCE, '-t', seconds.toFixed(2), '-vf', `scale=${width}:${height}`, ...ENCODE, clip]);
      } else {
        const media = scene.kind === 'demo' ? scene.file : join(dir, `image-${i}.${scene.image.mimeType === 'image/png' ? 'png' : 'jpg'}`);
        if (scene.kind === 'image') await writeFile(media, scene.image.bytes);
        const fit = `scale=${window.width}:${window.height}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos,pad=${window.width}:${window.height}:(ow-iw)/2:(oh-ih)/2:color=black`;
        await run(ffmpeg, [
          '-y', '-v', 'error',
          '-loop', '1', '-i', still,
          ...(scene.kind === 'image' ? ['-loop', '1'] : []), '-i', media,
          ...SILENCE,
          '-filter_complex', `[1:v]${fit}[m];[0:v][m]overlay=${window.x}:${window.y}:shortest=0,format=yuv420p[v]`,
          '-map', '[v]', '-map', '2:a',
          '-t', seconds.toFixed(2),
          ...ENCODE, clip,
        ]);
      }
      clips.push(clip);
    }
    const list = join(dir, 'clips.txt');
    await writeFile(list, clips.map((c) => `file '${c}'`).join('\n'));
    await run(ffmpeg, ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', request.output]);

    let start = 0;
    const cues: Array<{ start: number; end: number; text: string }> = [];
    const chapters: Array<{ at: number; title: string }> = [];
    for (const [i, scene] of request.scenes.entries()) {
      const end = start + lengths[i]!;
      cues.push({ start, end, text: scene.subtitle });
      if (scene.chapter) chapters.push({ at: Math.floor(start), title: scene.chapter });
      start = end;
    }
    return { seconds: total, srt: srtOf(cues), chapters };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
