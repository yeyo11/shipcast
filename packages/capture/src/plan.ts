import type { ScreenshotPage, TourStep } from '@shipcast/schema';

/** Browser-free parts of the capture: what to do, and the ffmpeg arguments, so they test without Chromium. */

export const DESKTOP = { width: 1440, height: 900, deviceScaleFactor: 1 } as const;
export const MOBILE = { width: 390, height: 844, deviceScaleFactor: 2 } as const;
export const TOUR_VIEWPORT = { width: 1280, height: 800 } as const;
export const GIF_WIDTH = 800;
export const GIF_FPS = 10;
/** A longer tour is cut: the GIF becomes the Instagram demo and the pull request's weight */
export const MAX_TOUR_SECONDS = 12;
export const MAX_STEPS = 12;

/** Slow on purpose: the viewer has to follow it. Scrolls are relative; a huge negative one reaches the top. */
export function defaultTour(): TourStep[] {
  return [
    { wait: 1500 },
    { scroll: 600 },
    { wait: 700 },
    { scroll: 600 },
    { wait: 700 },
    { scroll: 'bottom' },
    { wait: 900 },
    { scroll: -1_000_000 },
    { wait: 800 },
  ];
}

/** The steps to run: the given ones, else the default; a step that could leave the site or a tour that is too long is an error. */
export function planTour(site: string, steps: readonly TourStep[] | undefined): TourStep[] {
  const plan = steps && steps.length > 0 ? [...steps] : defaultTour();
  if (plan.length > MAX_STEPS) throw new Error(`a tour has at most ${MAX_STEPS} steps, not ${plan.length}`);
  for (const step of plan) if ('goto' in step) pageUrl(site, step.goto);
  return plan;
}

/** `path` on `site`; refuses anything that ends up on another origin. */
export function pageUrl(site: string, path: string): string {
  const base = new URL(site);
  const url = new URL(path, base);
  if (url.origin !== base.origin) throw new Error(`${path} leaves ${base.origin}: a tour and the screenshots stay on the site`);
  return url.href;
}

/** The file name stem of a page: `/` is `home`, `/docs/start` is `docs-start`. */
export function pageName(page: ScreenshotPage): string {
  if (page.name) return page.name;
  const slug = page.path
    .split(/[?#]/)[0]!
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'home';
}

/** The pages to capture: the given ones, else the root; names are made unique so no file overwrites another. */
export function planScreenshots(pages: readonly ScreenshotPage[] | undefined): Array<{ name: string; path: string }> {
  const list = pages && pages.length > 0 ? pages : [{ path: '/' }];
  const seen = new Map<string, number>();
  return list.map((page) => {
    const base = pageName(page);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return { name: count === 1 ? base : `${base}-${count}`, path: page.path };
  });
}

/** webm to an optimised GIF: one palette for the whole clip, so colours do not flicker between frames. */
export function gifArgs(input: string, output: string): string[] {
  return [
    '-y', '-v', 'error',
    '-t', String(MAX_TOUR_SECONDS),
    '-i', input,
    '-filter_complex',
    `[0:v]fps=${GIF_FPS},scale=${GIF_WIDTH}:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff:max_colors=128[p];[b][p]paletteuse=dither=none:diff_mode=rectangle`,
    '-loop', '0',
    output,
  ];
}

/** What a missing browser looks like to the person running Shipcast */
export const BROWSER_MISSING =
  'Chromium for Playwright is not installed: run `npx playwright install chromium` on the machine that runs Shipcast';

export function isBrowserMissing(error: unknown): boolean {
  return error instanceof Error && /Executable doesn't exist|playwright install/i.test(error.message);
}
