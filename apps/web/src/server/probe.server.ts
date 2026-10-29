import { TelemetryStore } from '@shipcast/engine';
import type { JobContext } from '@shipcast/runtime';
import type { AppContext } from './context.server';
import { SESSION_COOKIE, createSession } from './session.server';

/** The header that marks the probe's own requests, so the calls they cause are counted apart */
export const PROBE_HEADER = 'x-shipcast-probe';

/** The pages timed when SHIPCAST_PROBE_PAGES does not name them */
const DEFAULT_PAGES = ['/', '/launches', '/stats'];
const SETTLE_MS = 10_000;
/** How long a loaded page is left open, untouched, to count what an idle tab asks for */
const IDLE_MS = 30_000;

/**
 * The measurement's browser timings (docs/plans/performance-refactor.md, phase 0): every hour a
 * headless Chromium loads fixed pages of this app as a signed-in owner would, and records the
 * document's load (`<path>`) and the moment the page goes quiet (`<path> settled`). It loads them at
 * the public address, routed to this process, so cookies, links and the same-origin check behave
 * exactly as for the owner; nothing it does changes anything (pages only, no clicks). Each page is
 * then left open, untouched, for half a minute, and the requests it makes meanwhile are recorded as
 * the `idle-tab-requests` check (per minute, the worst page).
 * `SHIPCAST_PROBE_PAGES=/,/launches/6` names the pages; `off` turns the probe off.
 * `SHIPCAST_PROBE_TARGET` is the process that answers them, by default this one: in a split the probe
 * runs on `heavy` (it needs Chromium) and the pages are the web process's (`http://web:8744`).
 */
export async function probePages(ctx: AppContext, job: JobContext): Promise<void> {
  const setting = process.env.SHIPCAST_PROBE_PAGES?.trim();
  if (setting === 'off') {
    job.log('SHIPCAST_PROBE_PAGES=off: no page timed');
    return;
  }
  const pages = setting ? setting.split(',').map((p) => p.trim()).filter((p) => p.startsWith('/')) : DEFAULT_PAGES;
  const origin = new URL(ctx.app.publicUrl).origin;
  const inside = process.env.SHIPCAST_PROBE_TARGET?.trim().replace(/\/+$/, '') || `http://127.0.0.1:${ctx.app.port}`;
  const session = await createSession(ctx.secrets, 'shipcast-probe');
  const idle: Record<string, number> = {};

  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ extraHTTPHeaders: { [PROBE_HEADER]: '1' } });
    await context.addCookies([{ name: SESSION_COOKIE, value: session.value, url: origin, httpOnly: true, secure: origin.startsWith('https:'), sameSite: 'Lax' }]);
    // The public address answered by this process: what the browser sees is the owner's origin
    await context.route(`${origin}/**`, async (route) => {
      const url = route.request().url().replace(origin, inside);
      await route.fulfill({ response: await route.fetch({ url }) });
    });
    for (const path of pages) {
      const page = await context.newPage();
      const started = performance.now();
      try {
        const response = await page.goto(`${origin}${path}`, { waitUntil: 'load', timeout: 30_000 });
        const loaded = await page.evaluate(() => {
          const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
          return nav ? nav.loadEventEnd - nav.startTime : undefined;
        });
        const load = loaded && loaded > 0 ? loaded : performance.now() - started;
        const ok = response?.ok() === true;
        ctx.telemetry.timing({ kind: 'browser', name: path, outcome: ok ? 'ok' : 'error', ms: load });
        const settled = await page.waitForLoadState('networkidle', { timeout: SETTLE_MS }).then(
          () => true,
          () => false,
        );
        const settledMs = performance.now() - started;
        ctx.telemetry.timing({ kind: 'browser', name: `${path} settled`, outcome: settled ? 'ok' : 'error', ms: settledMs });
        let requests = 0;
        page.on('request', () => void requests++);
        await page.waitForTimeout(IDLE_MS);
        idle[path] = Math.round((requests * 60_000) / IDLE_MS);
        job.log(`${path}: ${response?.status() ?? 'no answer'}, loaded in ${Math.round(load)} ms, ${settled ? `quiet after ${Math.round(settledMs)} ms` : `still busy after ${SETTLE_MS / 1000} s`}, ${idle[path]} requests a minute idle`);
      } catch (error) {
        ctx.telemetry.timing({ kind: 'browser', name: path, outcome: 'error', ms: performance.now() - started });
        job.log(`${path}: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
  const worst = Math.max(0, ...Object.values(idle));
  await new TelemetryStore(ctx.registry.database).recordCheck({ name: 'idle-tab-requests', ok: worst < 1, value: worst, detail: { perPage: idle } });
}
