import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import AxeBuilder from '@axe-core/playwright';
import { chromium, type BrowserContext, type Locator, type Page } from 'playwright-core';

/**
 * The app's reflow and accessibility check, beside lighthouse-check.ts: neither runs in CI (they
 * need a database and a session). Against a running app, it signs in with a console link, opens every
 * page at each width and fails on horizontal overflow (WCAG 2.2 reflow: nothing wider than a 320 px
 * screen) or on an axe-core violation of serious or critical impact. It also opens the command
 * palette and an alert dialog, so the popups are checked too, and then the surfaces that only exist
 * once opened: the writing assistant (bubble, sheet, history), the tour's first steps, the date
 * pickers on Stats and on a launch, the Comments filters and every Channels tab. Those also fail on a
 * control smaller than 44 px or a popup that leaves the screen. Each of them only opens and closes UI
 * (it never sends, saves, schedules or connects) and is skipped, with a line saying why, when what it
 * opens is not there: an empty preview still runs to the end. Not part of `pnpm test`.
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
const skipped: string[] = [];
let views = 0;

/** A check that has nothing to open here: said, not failed, so an empty preview still runs */
function skip(name: string, width: number, why: string): void {
  const line = `${name} @ ${width}px: ${why}`;
  skipped.push(line);
  console.log(`skipped: ${line}`);
}

/** Whether the locator shows up in time: the optional surfaces wait for it rather than fail */
async function shows(locator: Locator, timeout = 5000): Promise<boolean> {
  return locator
    .first()
    .waitFor({ state: 'visible', timeout })
    .then(() => true)
    .catch(() => false);
}

async function inspect(page: Page, name: string, width: number): Promise<void> {
  views += 1;
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

/** The smallest target a finger can hit reliably (WCAG 2.5.5, and Apple's and Material's minimum) */
const TARGET = 44;

/**
 * A popup's own problems, which the page-wide check cannot see: a fixed or portalled popup that
 * leaves the screen widens nothing, and its controls are where a small target hurts most. A checkbox
 * or radio is measured by its label, which is what takes the tap; a link inside a sentence is
 * exempt, as WCAG exempts it.
 */
async function inspectPopup(page: Page, scope: Locator, name: string, width: number): Promise<void> {
  const found = await scope.first().evaluate((root, min) => {
    const box = root.getBoundingClientRect();
    const out = box.left < -1 || box.right > window.innerWidth + 1 ? `${Math.round(box.left)}..${Math.round(box.right)}px of ${window.innerWidth}` : null;
    const interactive = 'button, a[href], input:not([type="hidden"]), select, textarea, [role="button"], [role="tab"], [role="option"], [role="menuitem"], [role="spinbutton"], [role="checkbox"], [role="radio"], [role="combobox"]';
    const seen = new Set<Element>();
    const small: string[] = [];
    for (const el of [root, ...root.querySelectorAll(interactive)]) {
      if (!el.matches(interactive)) continue;
      const target = el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio') ? (el.closest('label') ?? el) : el;
      if (seen.has(target)) continue;
      seen.add(target);
      if (el.tagName === 'A' && getComputedStyle(el).display === 'inline' && el.parentElement?.closest('p, li')) continue;
      const r = target.getBoundingClientRect();
      // Not drawn (visually hidden, a closed panel): nothing to tap
      if (r.width < 2 || r.height < 2 || getComputedStyle(target).visibility === 'hidden') continue;
      if (r.width >= min && r.height >= min) continue;
      const label = (target.getAttribute('aria-label') ?? target.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 30);
      small.push(`${target.tagName.toLowerCase()} "${label}" ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
    return { out, small };
  }, TARGET);
  if (found.out) findings.push({ page: name, width, problem: `the popup leaves the screen (${found.out})` });
  if (found.small.length > 0) findings.push({ page: name, width, problem: `${found.small.length} targets under ${TARGET}px (${found.small.slice(0, 5).join(', ')})` });
  await inspect(page, name, width);
  await shot(page, name, width, false);
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

  // The writing assistant on Write. On a phone (ChatPanel's PHONE, 760 px) it is a floating bubble
  // that opens a full-screen sheet; wider, a panel beside the text that starts open. Only the
  // history is opened, and a past session read back: nothing is sent to the assistant.
  {
    const write = await visit(context, '/write', 'write-assistant', width);
    const bubble = write.getByRole('button', { name: 'Open the assistant’s chat' });
    let chat: Locator | null = write.locator('.chat-panel');
    if (width <= 760) {
      if (await shows(bubble)) {
        await inspectPopup(write, bubble, 'assistant-bubble', width);
        await bubble.first().click();
        chat = write.getByRole('dialog', { name: 'The assistant’s chat' });
        if (!(await shows(chat))) chat = null;
      } else chat = null;
    } else if (!(await shows(chat, 2000))) {
      // Closed to its icon (the panel may stop starting open): the icon opens it
      if (await shows(bubble, 2000)) {
        await bubble.first().click();
        if (!(await shows(chat))) chat = null;
      } else chat = null;
    }
    if (!chat) skip('assistant', width, 'no assistant bubble or panel on /write');
    else {
      await inspectPopup(write, chat, width <= 760 ? 'assistant-sheet' : 'assistant-panel', width);
      await chat.getByRole('button', { name: 'Past sessions' }).click();
      const history = chat.locator('.chat-history');
      await history.waitFor();
      // The first page of sessions has loaded, or failed, once "Loading…" is gone
      await history.getByRole('status').filter({ hasText: 'Loading' }).waitFor({ state: 'detached', timeout: 10000 }).catch(() => undefined);
      await inspectPopup(write, chat, 'assistant-history', width);
      const session = chat.locator('.chat-session');
      if (await shows(session, 1000)) {
        // Reading a session back is a GET; Accept and Reject in it are left alone
        await session.first().click();
        await chat.locator('.chat-history').waitFor({ state: 'detached', timeout: 10000 }).catch(() => undefined);
        await inspectPopup(write, chat, 'assistant-session', width);
      } else skip('assistant-session', width, 'no saved assistant session to read back');
      await chat.getByRole('button', { name: 'Close the chat' }).click();
    }
    await write.close();
  }

  // The tour, started as the owner starts it: "Take the tour" in the user menu, or in More on a
  // phone. Its first two steps; Next only moves between pages, and Escape ends it.
  {
    const home = await visit(context, '/', 'launches-tour', width);
    let asked = false;
    if (width < 860) {
      await home.getByRole('button', { name: /^More/ }).click();
      const take = home.getByRole('dialog', { name: 'More' }).getByRole('button', { name: 'Take the tour' });
      if (await shows(take)) {
        await take.click();
        asked = true;
      }
    } else {
      await home.getByRole('button', { name: /^Signed in as / }).click();
      const take = home.getByRole('menuitem', { name: 'Take the tour' });
      if (await shows(take)) {
        await take.click();
        asked = true;
      }
    }
    const card = home.locator('.tour-card');
    if (!asked) skip('tour', width, 'no "Take the tour" entry');
    else if (!(await shows(card, 15000))) skip('tour', width, 'the tour asked for opened no card');
    else {
      for (const n of [1, 2]) {
        // A step is shown once its count reads it and the card is no longer moving to it
        await card.locator('.tour-count').filter({ hasText: new RegExp(`^\\s*${n}\\s*/`) }).waitFor({ timeout: 15000 });
        await home.locator('.tour-card:not([aria-busy="true"])').waitFor({ timeout: 15000 });
        await inspectPopup(home, card, `tour-step-${n}`, width);
        if (n === 1) await card.getByRole('button', { name: 'Next' }).click();
      }
      await home.keyboard.press('Escape');
    }
    await home.close();
  }

  // The calendar as Stats opens it: Chart, then the custom range's day picker (a popover in a
  // popover, a sheet over a sheet on a phone). Days are not picked and the range is not shown.
  {
    const stats = await visit(context, '/stats', 'stats-picker', width);
    const chartButton = stats.locator('.stats-filterbar').getByRole('button', { name: /^Chart/ });
    if (!(await shows(chartButton))) skip('stats-date-picker', width, 'no Chart filter on /stats');
    else {
      await chartButton.click();
      const chart = stats.getByRole('dialog', { name: 'The chart' });
      await chart.waitFor();
      await inspectPopup(stats, chart, 'stats-chart', width);
      await chart.getByRole('button', { name: /^Custom range:/ }).click();
      const calendar = stats.getByRole('dialog', { name: 'Custom range' });
      await calendar.waitFor();
      await inspectPopup(stats, calendar, 'stats-date-picker', width);
      await stats.keyboard.press('Escape');
    }
    await stats.close();
  }

  // The same day picker and the time field on a launch's schedule, which only a launch with a
  // channel left to schedule shows. The calendar opens and closes; Schedule is never pressed.
  if (!launchHref) skip('schedule', width, 'no launch to open');
  else {
    const launch = await visit(context, launchHref, 'launch-schedule', width);
    const day = launch.getByRole('button', { name: /^Day for / });
    if (!(await shows(day, 2000))) skip('schedule', width, 'the first launch has no channel to schedule');
    else {
      await inspectPopup(launch, launch.locator('.sched-pick'), 'schedule-fields', width);
      await day.first().click();
      const calendar = launch.getByRole('dialog', { name: /^Day for / });
      await calendar.waitFor();
      await inspectPopup(launch, calendar, 'schedule-date-picker', width);
      await launch.keyboard.press('Escape');
    }
    await launch.close();
  }

  // The Comments filters: a popover on a desktop, a bottom sheet on a phone, and a Select's list
  // opened inside it. Choosing an option would only filter, but none is chosen: Escape closes it.
  {
    const comments = await visit(context, '/comments', 'comments-filters', width);
    const button = comments.getByRole('search', { name: 'Filter the comments' }).getByRole('button', { name: /^Filters/ });
    if (!(await shows(button))) skip('comments-filters', width, 'no Filters button on /comments');
    else {
      await button.click();
      const filters = comments.getByRole('dialog', { name: 'Filters' });
      await filters.waitFor();
      await inspectPopup(comments, filters, 'comments-filters', width);
      const state = filters.getByRole('combobox', { name: 'State' });
      if (await shows(state, 1000)) {
        await state.click();
        const list = comments.getByRole('listbox');
        if (await shows(list)) {
          await inspectPopup(comments, list, 'comments-filter-list', width);
          await comments.keyboard.press('Escape');
        } else skip('comments-filter-list', width, 'the State select opened no list');
      } else skip('comments-filter-list', width, 'no State select in the filters');
      await comments.keyboard.press('Escape');
    }
    await comments.close();
  }

  // Every Channels tab, one per group of networks (server/network-groups.ts), read off the tab
  // list so a new group is checked without touching this script. A tab only changes the address.
  {
    const channels = await visit(context, '/channels', 'channels-tabs', width);
    const list = channels.getByRole('tablist', { name: 'Kinds of channel' });
    const tabs = list.getByRole('tab');
    const count = await tabs.count();
    if (count === 0) skip('channels-tabs', width, 'no tabs on /channels');
    else await inspectPopup(channels, list, 'channels-tab-list', width);
    for (let i = 0; i < count; i++) {
      const tab = tabs.nth(i);
      // Named by the group, without the count of accounts the tab carries
      const name = `channels-tab-${((await tab.textContent()) ?? String(i)).replace(/\d+/g, '').trim().toLowerCase().replace(/[^a-z]+/g, '-').replace(/-+$/, '')}`;
      await tab.click();
      await tab.and(channels.locator('[aria-selected="true"]')).waitFor();
      await channels.waitForLoadState('networkidle');
      await inspectPopup(channels, channels.locator('[role="tabpanel"]:visible'), name, width);
    }
    await channels.close();
  }

  // The sign-in page, without a session
  const signedOut = await browser.newContext({ reducedMotion: 'reduce' });
  (await visit(signedOut, '/login', 'sign-in', width)).close();
  await signedOut.close();
}

await browser.close();

// Counted as they are inspected: how many there are depends on what the app has to open
const skips = skipped.length > 0 ? ` (${skipped.length} skipped)` : '';
if (findings.length === 0) {
  console.log(`No horizontal overflow, no target under ${TARGET}px and no serious or critical axe violations: ${views} views at ${widths.join(', ')} px${skips}.`);
} else {
  for (const f of findings) console.log(`${f.page} @ ${f.width}px: ${f.problem}`);
  console.log(`${findings.length} problems in ${views} views${skips}.`);
  process.exitCode = 1;
}
