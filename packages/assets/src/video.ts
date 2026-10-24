import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface ReelOptions {
  /** The frame colour around the demo when it is not 9:16 */
  background?: string;
  /** Instagram refuses Reels shorter than 3 s; a shorter demo loops up to this */
  minSeconds?: number;
  ffmpeg?: string;
  ffprobe?: string;
}

export const REEL_WIDTH = 1080;
export const REEL_HEIGHT = 1920;

/** A media file's duration in seconds, through ffprobe. */
export async function durationSeconds(file: string, ffprobe = 'ffprobe'): Promise<number> {
  const { stdout } = await run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  const seconds = Number(stdout.trim());
  if (!(seconds > 0)) throw new Error(`could not read the duration of ${file}`);
  return seconds;
}

/**
 * The project's demo (a GIF, usually) as an Instagram Reel: 1080×1920 H.264 in yuv420p at 30 fps,
 * the demo scaled to the width and centred on a plain frame, looped up to 3 s when shorter, with a
 * silent AAC track (some players and uploads expect one), and `faststart` so it streams.
 */
export async function demoToReel(input: string, output: string, options: ReelOptions = {}): Promise<void> {
  const ffmpeg = options.ffmpeg ?? 'ffmpeg';
  const minSeconds = options.minSeconds ?? 3;
  const background = (options.background ?? '#111418').replace('#', '0x');
  const seconds = await durationSeconds(input, options.ffprobe);
  const loops = Math.max(0, Math.ceil(minSeconds / seconds) - 1);
  const length = Math.max(seconds, minSeconds);

  await run(ffmpeg, [
    '-y',
    '-v',
    'error',
    '-stream_loop',
    String(loops),
    '-i',
    input,
    '-f',
    'lavfi',
    '-i',
    'anullsrc=channel_layout=stereo:sample_rate=44100',
    '-t',
    length.toFixed(2),
    '-vf',
    `scale=${REEL_WIDTH}:-2:flags=lanczos,pad=${REEL_WIDTH}:${REEL_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=${background},fps=30,format=yuv420p`,
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    '20',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-shortest',
    '-movflags',
    '+faststart',
    output,
  ]);
}
