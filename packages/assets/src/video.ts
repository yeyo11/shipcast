import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface DemoVideoOptions {
  /** Instagram plays carousel videos of 3 to 60 s: a shorter demo loops up to the first, a longer one is cut at the second */
  minSeconds?: number;
  maxSeconds?: number;
  ffmpeg?: string;
  ffprobe?: string;
}

/** A media file's duration in seconds, through ffprobe. */
export async function durationSeconds(file: string, ffprobe = 'ffprobe'): Promise<number> {
  const { stdout } = await run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  const seconds = Number(stdout.trim());
  if (!(seconds > 0)) throw new Error(`could not read the duration of ${file}`);
  return seconds;
}

/**
 * The project's demo (a GIF, usually) laid over a backdrop image, inside the window the backdrop
 * leaves for it: the demo scaled to fit, centred on black. H.264 in yuv420p at 30 fps with a silent
 * AAC track (some players expect one), `faststart` so it streams, between 3 and 60 seconds long.
 */
export async function demoOnBackdrop(
  input: string,
  backdrop: string,
  window: { x: number; y: number; width: number; height: number },
  output: string,
  options: DemoVideoOptions = {},
): Promise<void> {
  const ffmpeg = options.ffmpeg ?? 'ffmpeg';
  const minSeconds = options.minSeconds ?? 3;
  const maxSeconds = options.maxSeconds ?? 60;
  const seconds = await durationSeconds(input, options.ffprobe);
  const loops = Math.max(0, Math.ceil(minSeconds / seconds) - 1);
  const length = Math.min(Math.max(seconds, minSeconds), maxSeconds);
  const { x, y, width, height } = window;

  await run(ffmpeg, [
    '-y', '-v', 'error',
    '-loop', '1', '-i', backdrop,
    '-stream_loop', String(loops), '-i', input,
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
    '-filter_complex',
    // Fit inside the window without ever exceeding it (even sides), then centre on black
    `[1:v]scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black[demo];` +
      `[0:v][demo]overlay=${x}:${y},fps=30,format=yuv420p[v]`,
    '-map', '[v]', '-map', '2:a',
    '-t', length.toFixed(2),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '22',
    '-c:a', 'aac', '-b:a', '64k',
    '-movflags', '+faststart',
    output,
  ]);
}
