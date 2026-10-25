import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ScreenshotPage, TourStep } from '@shipcast/schema';
import { chromium, type Browser, type Page } from 'playwright-core';
import { BROWSER_MISSING, DESKTOP, gifArgs, isBrowserMissing, MAX_TOUR_SECONDS, MOBILE, pageUrl, planScreenshots, planTour, TOUR_VIEWPORT } from './plan.ts';

const run = promisify(execFile);

export interface Screenshot {
  name: string;
  viewport: 'desktop' | 'mobile';
  png: Uint8Array;
}

export interface CaptureOptions {
  /** Per page: navigation to network idle, and each tour click */
  timeoutMs?: number;
  /** A Chromium binary other than the one `playwright install` put in place */
  executablePath?: string;
  ffmpeg?: string;
}

/** The two things the engine asks of a site; the engine's tests replace it with a fake. */
export interface SiteCapture {
  screenshots(site: string, pages?: readonly ScreenshotPage[]): Promise<Screenshot[]>;
  tour(site: string, steps?: readonly TourStep[]): Promise<{ gif: Uint8Array; seconds: number }>;
}

async function launch(options: CaptureOptions): Promise<Browser> {
  try {
    return await chromium.launch({ executablePath: options.executablePath });
  } catch (error) {
    if (isBrowserMissing(error)) throw new Error(BROWSER_MISSING);
    throw error;
  }
}

async function open(page: Page, url: string, timeout: number): Promise<void> {
  const response = await page.goto(url, { waitUntil: 'networkidle', timeout }).catch((error: unknown) => {
    // A page that never goes quiet (a poll, a socket) is still a page: take it as it is after the load event
    if (error instanceof Error && /Timeout/.test(error.message)) return page.goto(url, { waitUntil: 'load', timeout });
    throw error;
  });
  if (response && !response.ok()) throw new Error(`${url} answered ${response.status()}`);
}

/** Each page at desktop 1440x900 and mobile 390x844 (@2x), the first screen only, not the full page. */
export async function captureScreenshots(site: string, pages?: readonly ScreenshotPage[], options: CaptureOptions = {}): Promise<Screenshot[]> {
  const timeout = options.timeoutMs ?? 30_000;
  const plan = planScreenshots(pages);
  const browser = await launch(options);
  try {
    const shots: Screenshot[] = [];
    for (const [viewport, size] of [['desktop', DESKTOP], ['mobile', MOBILE]] as const) {
      const context = await browser.newContext({
        viewport: { width: size.width, height: size.height },
        deviceScaleFactor: size.deviceScaleFactor,
        isMobile: viewport === 'mobile',
        hasTouch: viewport === 'mobile',
      });
      try {
        const page = await context.newPage();
        for (const { name, path } of plan) {
          await open(page, pageUrl(site, path), timeout);
          shots.push({ name, viewport, png: new Uint8Array(await page.screenshot({ type: 'png', fullPage: false })) });
        }
      } finally {
        await context.close();
      }
    }
    return shots;
  } finally {
    await browser.close();
  }
}

/**
 * Runs in the page: scrolls by `by` pixels (or to the bottom) over a moment, so the recording shows
 * motion rather than a jump. A string, because this package has no DOM types to type it with.
 */
const SCROLL_SCRIPT = `(target) => new Promise((done) => {
  const from = window.scrollY;
  const max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  const to = Math.min(max, Math.max(0, target === 'bottom' ? max : from + target));
  const started = performance.now();
  const frame = (now) => {
    const t = Math.min(1, (now - started) / 900);
    window.scrollTo(0, from + (to - from) * (t * t * (3 - 2 * t)));
    if (t < 1) requestAnimationFrame(frame);
    else done();
  };
  requestAnimationFrame(frame);
})`;

async function scrollSmoothly(page: Page, by: number | 'bottom'): Promise<void> {
  await page.evaluate(`(${SCROLL_SCRIPT})(${JSON.stringify(by)})`);
}

async function perform(page: Page, site: string, step: TourStep, timeout: number): Promise<void> {
  if ('wait' in step) await page.waitForTimeout(step.wait);
  else if ('scroll' in step) await scrollSmoothly(page, step.scroll);
  else if ('click' in step) await page.click(step.click, { timeout });
  else await open(page, pageUrl(site, step.goto), timeout);
}

/** Records the tour in Chromium at 1280x800 and turns the video into a GIF (12 fps, 960 wide, at most 20 s) with ffmpeg. */
export async function recordTour(site: string, steps?: readonly TourStep[], options: CaptureOptions = {}): Promise<{ gif: Uint8Array; seconds: number }> {
  const timeout = options.timeoutMs ?? 30_000;
  const plan = planTour(site, steps);
  const work = await mkdtemp(join(tmpdir(), 'shipcast-tour-'));
  try {
    const browser = await launch(options);
    let started = 0;
    let ended = 0;
    try {
      const context = await browser.newContext({ viewport: TOUR_VIEWPORT, recordVideo: { dir: work, size: TOUR_VIEWPORT } });
      try {
        const page = await context.newPage();
        await open(page, pageUrl(site, '/'), timeout);
        started = Date.now();
        for (const step of plan) await perform(page, site, step, timeout);
        ended = Date.now();
      } finally {
        // The video file is only complete once the context is closed
        await context.close();
      }
    } finally {
      await browser.close();
    }
    const webm = (await readdir(work)).find((f) => f.endsWith('.webm'));
    if (!webm) throw new Error('Playwright recorded no video');
    const output = join(work, 'tour.gif');
    try {
      await run(options.ffmpeg ?? 'ffmpeg', gifArgs(join(work, webm), output));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('ffmpeg is not on PATH: install it to turn the recorded tour into a GIF');
      throw new Error(`ffmpeg could not make the GIF: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { gif: new Uint8Array(await readFile(output)), seconds: Math.min(MAX_TOUR_SECONDS, Math.round(((ended - started) / 1000) * 10) / 10) };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** The real thing: headless Chromium. */
export function playwrightCapture(options: CaptureOptions = {}): SiteCapture {
  return {
    screenshots: (site, pages) => captureScreenshots(site, pages, options),
    tour: (site, steps) => recordTour(site, steps, options),
  };
}
