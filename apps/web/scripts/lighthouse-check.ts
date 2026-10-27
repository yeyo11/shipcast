import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { launch } from 'chrome-launcher';
import lighthouse from 'lighthouse';
import { chromium } from 'playwright-core';

/**
 * The app's Lighthouse gate (milestone 3 of docs/plans/goal-after-mvp.md). Like reflow-check.ts it
 * needs a running app and a session, which CI has neither of, so it runs against a preview copy (or
 * production, read-only) by hand before a design change ships. It opens each page signed in, scores
 * it on a phone and on a desktop, and fails when a category falls under its threshold.
 *
 *   node apps/web/scripts/lighthouse-check.ts --base https://host:port
 *     (--state /tmp/state.json | --link 'https://host:port/auth/link?token=…')
 *     [--pages /,/write,/channels] [--report /tmp/lighthouse.json]
 *
 * --state is the session file reflow-check.ts writes; --link signs in once and writes it.
 * Accessibility and best practices are the gate. Performance is measured and printed but does not
 * fail the run: a preview shares the owner's machine with builds and tests, and on 2026-10-27 the same
 * page scored 74 and then 38 a few minutes apart, so a line drawn on it would only report the load.
 */

const { values } = parseArgs({
  options: {
    base: { type: 'string' },
    link: { type: 'string' },
    state: { type: 'string', default: '/tmp/shipcast-lighthouse-state.json' },
    pages: { type: 'string', default: '/,/write,/channels,/comments,/stats,/settings,/settings/api' },
    report: { type: 'string' },
    chrome: { type: 'string' },
  },
});

if (!values.base) {
  console.error('usage: lighthouse-check.ts --base <url> (--state <file> | --link <sign-in link>) [--pages /,/write] [--report <file>]');
  process.exit(2);
}
const base = values.base.replace(/\/+$/, '');

/** The minimum score of each category, per form factor */
const THRESHOLDS: Record<'mobile' | 'desktop', Record<string, number>> = {
  mobile: { accessibility: 0.95, 'best-practices': 0.9, performance: 0 },
  desktop: { accessibility: 0.95, 'best-practices': 0.9, performance: 0 },
};

// A sign-in link works once: turn it into a session file, as reflow-check.ts does
if (values.link) {
  const browser = await chromium.launch(values.chrome ? { executablePath: values.chrome } : {});
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  await page.goto(values.link, { waitUntil: 'networkidle' });
  writeFileSync(values.state, JSON.stringify(await context.storageState()));
  await browser.close();
}

const state = JSON.parse(readFileSync(values.state, 'utf8')) as { cookies: Array<{ name: string; value: string; domain: string }> };
const host = new URL(base).hostname;
const cookie = state.cookies
  .filter((c) => host === c.domain.replace(/^\./, '') || host.endsWith(c.domain))
  .map((c) => `${c.name}=${c.value}`)
  .join('; ');
if (!cookie) {
  console.error(`No session cookie for ${host} in ${values.state}: sign in again with --link`);
  process.exit(2);
}

const chrome = await launch({ chromePath: values.chrome, chromeFlags: ['--headless=new', '--ignore-certificate-errors'] });
interface Row {
  page: string;
  formFactor: 'mobile' | 'desktop';
  scores: Record<string, number>;
  failed: string[];
  why: string[];
}
const rows: Row[] = [];
try {
  for (const path of values.pages.split(',')) {
    for (const formFactor of ['mobile', 'desktop'] as const) {
      const result = await lighthouse(
        `${base}${path}`,
        { port: chrome.port, output: 'json', logLevel: 'error', onlyCategories: Object.keys(THRESHOLDS[formFactor]), extraHeaders: { Cookie: cookie } },
        formFactor === 'desktop'
          ? { extends: 'lighthouse:default', settings: { formFactor: 'desktop', screenEmulation: { mobile: false, width: 1350, height: 940, deviceScaleFactor: 1, disabled: false } } }
          : undefined,
      );
      if (!result) throw new Error(`Lighthouse returned nothing for ${path}`);
      const { lhr } = result;
      // A page that redirected to sign-in scored the sign-in page: say so rather than pass it
      if (new URL(lhr.finalDisplayedUrl).pathname.startsWith('/login')) throw new Error(`${path} sent Lighthouse to the sign-in page: the session is not valid`);
      const scores = Object.fromEntries(Object.entries(lhr.categories).map(([id, c]) => [id, c.score ?? 0]));
      const failed = Object.entries(THRESHOLDS[formFactor])
        .filter(([id, min]) => (scores[id] ?? 0) < min)
        .map(([id, min]) => `${id} ${Math.round((scores[id] ?? 0) * 100)} < ${Math.round(min * 100)}`);
      // For a category under its line, the audits that cost it points, so the report says what to fix
      const why = failed.length
        ? Object.entries(THRESHOLDS[formFactor])
            .filter(([id, min]) => (scores[id] ?? 0) < min)
            .flatMap(([id]) =>
              (lhr.categories[id]?.auditRefs ?? [])
                .filter((ref) => ref.weight > 0 && (lhr.audits[ref.id]?.score ?? 1) < 0.9)
                .map((ref) => `${id}: ${lhr.audits[ref.id]?.title ?? ref.id}${lhr.audits[ref.id]?.displayValue ? ` (${lhr.audits[ref.id]?.displayValue})` : ''}`),
            )
        : [];
      rows.push({ page: path, formFactor, scores, failed, why });
      console.log(`${failed.length ? 'FAIL' : 'ok  '} ${formFactor.padEnd(7)} ${path.padEnd(16)} ${Object.entries(scores).map(([id, s]) => `${id} ${Math.round(s * 100)}`).join(' · ')}${failed.length ? `  (${failed.join(', ')})` : ''}`);
      for (const line of why) console.log(`       ↳ ${line}`);
    }
  }
} finally {
  chrome.kill();
}

if (values.report) writeFileSync(values.report, JSON.stringify(rows, null, 2));
const failures = rows.filter((r) => r.failed.length > 0);
console.log(failures.length ? `\n${failures.length} of ${rows.length} runs under their thresholds.` : `\nEvery page passes on a phone and on a desktop: ${rows.length} runs.`);
process.exit(failures.length ? 1 : 0);
