import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import AxeBuilder from '@axe-core/playwright';
import { chromium, type BrowserContext, type Page } from 'playwright-core';

/**
 * The app's reflow and accessibility check, standing in for a Lighthouse gate CI cannot run (it needs
 * a database and a session). Against a running app, it signs in with a console link, opens every
 * page at each width and fails on horizontal overflow (WCAG 2.2 reflow: nothing wider than a 320 px
 * screen) or on an axe-core violation of serious or critical impact. It also opens the command
 * palette and an alert dialog, so the popups are checked too. Not part of `pnpm test`.
 *
 *   node apps/web/scripts/reflow-check.ts --base https://host:port --link 'https://host:port/auth/link?token=…'
 *     [--widths 320,390,1280] [--shots /tmp/ui-preview] [--state /tmp/state.json]
 *
 * --state keeps the session in a file, so a second run needs no new link (each link works once).
 */

const { values } = parseArgs({
  options: {
    base: { type: 'string' },
    link: { type: 'string' },
    widths: { type: 'string', default: '320' },
    shots: { type: 'string' },
    state: { type: 'string' },
    browser: { type: 'string' },
  },
});

if (!values.base) {
  console.error('usage: reflow-check.ts --base <url> [--link <console sign-in link>] [--state <file>] [--widths 320,390,1280] [--shots <dir>]');
  process.exit(2);
}
const base = values.base.replace(/\/+$/, '');
const widths = values.widths.split(',').map(Number);
if (values.shots) mkdirSync(values.shots, { recursive: true });

interface Finding {
  page: string;
  width: number;
  problem: string;
}
const findings: Finding[] = [];

async function inspect(page: Page, name: string, width: number): Promise<void> {
  const overflow = await page.evaluate(() => {
    const wide = document.documentElement.scrollWidth - window.innerWidth;
    if (wide <= 0) return null;
    // Name the widest offenders, so the report says what to fix rather than only that something is wide
    const culprits = [...document.querySelectorAll<HTMLElement>('body *')]
      .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1)
      .slice(0, 5)
      .map((el) => `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? `.${el.className.split(' ').join('.')}` : ''}`);
    return { wide, culprits };
  });
  if (overflow) findings.push({ page: name, width, problem: `overflows by ${overflow.wide}px (${overflow.culprits.join(', ')})` });

  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']).analyze();
  for (const v of axe.violations) {
    if (v.impact !== 'serious' && v.impact !== 'critical') continue;
    findings.push({ page: name, width, problem: `axe ${v.impact} ${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')})` });
  }
}

async function shot(page: Page, name: string, width: number, fullPage = true): Promise<void> {
  if (!values.shots) return;
  await page.screenshot({ path: join(values.shots, `${name}-${width}.png`), fullPage });
}

async function visit(context: BrowserContext, path: string, name: string, width: number): Promise<Page> {
  const page = await context.newPage();
  await page.setViewportSize({ width, height: width < 800 ? 780 : 900 });
  await page.goto(`${base}${path}`, { waitUntil: 'networkidle' });
  await inspect(page, name, width);
  await shot(page, name, width);
  return page;
}

const browser = await chromium.launch({ executablePath: values.browser });
const context = await browser.newContext({ storageState: values.state && !values.link ? values.state : undefined, reducedMotion: 'reduce' });
if (values.link) {
  const page = await context.newPage();
  await page.goto(values.link, { waitUntil: 'networkidle' });
  if (new URL(page.url()).pathname === '/login') throw new Error('the sign-in link did not sign in: it works once and for 15 minutes');
  await page.close();
  if (values.state) await context.storageState({ path: values.state });
}

// A launch's page: the first launch on the list
const first = await context.newPage();
await first.goto(`${base}/`, { waitUntil: 'networkidle' });
const launchHref = await first.locator('a[href^="/launches/"]').first().getAttribute('href').catch(() => null);
await first.close();

const PAGES: Array<[string, string]> = [
  ['/', 'launches'],
  ...(launchHref ? ([[launchHref, 'launch']] as Array<[string, string]>) : []),
  ['/launch', 'launch-a-repo'],
  ['/write', 'write'],
  ['/channels', 'channels'],
  ['/channels/mastodon', 'connect'],
  ['/comments', 'comments'],
  ['/settings', 'settings'],
  ['/settings/automation', 'automation'],
  ['/settings/ai', 'ai'],
  ['/settings/api', 'api'],
  ['/stats', 'stats'],
  ['/design/components', 'components'],
  ['/no-such-page', 'not-found'],
];

for (const width of widths) {
  for (const [path, name] of PAGES) (await visit(context, path, name, width)).close();

  // The command palette, opened by its shortcut
  const palette = await visit(context, '/', 'launches-palette', width);
  await palette.keyboard.press('Control+K');
  await palette.getByRole('dialog', { name: 'Command palette' }).waitFor();
  await palette.keyboard.type('chan');
  await inspect(palette, 'palette', width);
  await shot(palette, 'dialog-palette', width, false);
  await palette.close();

  // An alert dialog, in place of window.confirm
  const alert = await visit(context, '/design/components', 'components-alert', width);
  await alert.getByRole('button', { name: 'Disconnect', exact: true }).first().click();
  await alert.getByRole('alertdialog').waitFor();
  await inspect(alert, 'alert-dialog', width);
  await shot(alert, 'dialog-alert', width, false);
  await alert.close();

  // The phone's More drawer
  if (width < 860) {
    const more = await visit(context, '/', 'launches-more', width);
    await more.getByRole('button', { name: /^More/ }).click();
    await more.getByRole('dialog', { name: 'More' }).waitFor();
    await inspect(more, 'more-drawer', width);
    await shot(more, 'drawer-more', width, false);
    await more.close();
  }

  // The sign-in page, without a session
  const signedOut = await browser.newContext({ reducedMotion: 'reduce' });
  (await visit(signedOut, '/login', 'sign-in', width)).close();
  await signedOut.close();
}

await browser.close();

const checked = widths.length * (PAGES.length + 4);
if (findings.length === 0) {
  console.log(`No horizontal overflow and no serious or critical axe violations: ${checked} views at ${widths.join(', ')} px.`);
} else {
  for (const f of findings) console.log(`${f.page} @ ${f.width}px: ${f.problem}`);
  console.log(`${findings.length} problems in ${checked} views.`);
  process.exitCode = 1;
}
