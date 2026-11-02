/*
 * Draws the installed app's files into design/pwa/, where the app serves them (the design folder is
 * its public folder): the icons from the logo's mark (design/logo/mark.svg), and the offline page's
 * scene from its React component. They are committed, so a build never needs a browser; run this
 * again when the mark or the scene changes (through tsx: Node's type stripping does not read JSX):
 *
 *   pnpm pwa:assets [--browser /usr/bin/google-chrome]
 *
 * - icon-192.png, icon-512.png: the mark on its own, transparent around it (purpose "any");
 * - maskable-192.png, maskable-512.png: the mark inside the safe zone of a full-bleed ground, so a
 *   launcher's circle or squircle never cuts it (purpose "maskable");
 * - apple-touch-icon.png, 180 px: iOS fills transparency with black and rounds the corners itself;
 * - offline.svg: the Offline scene (board Offline), for the offline page the service worker shows.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright-core';
import { renderToStaticMarkup } from 'react-dom/server';
import { Offline } from '../src/components/illustrations/Offline.tsx';
import { MANIFEST_COLORS } from '../src/pwa/manifest.ts';

const { values } = parseArgs({ options: { browser: { type: 'string' } } });
const design = new URL('../../../design/', import.meta.url);
const mark = readFileSync(new URL('logo/mark.svg', design), 'utf8');
const out = new URL('pwa/', design);
mkdirSync(out, { recursive: true });

writeFileSync(new URL('offline.svg', out), `${renderToStaticMarkup(<Offline />).replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ')}\n`);
console.log('design/pwa/offline.svg');

/** `scale`: the share of the side the mark takes; `ground`: a full-bleed colour, or none */
const ICONS: Array<{ file: string; size: number; scale: number; ground?: string }> = [
  { file: 'icon-192.png', size: 192, scale: 1 },
  { file: 'icon-512.png', size: 512, scale: 1 },
  // The maskable safe zone is a circle of 80% of the side; a square mark fits it at about 56%
  { file: 'maskable-192.png', size: 192, scale: 0.56, ground: MANIFEST_COLORS.background },
  { file: 'maskable-512.png', size: 512, scale: 0.56, ground: MANIFEST_COLORS.background },
  { file: 'apple-touch-icon.png', size: 180, scale: 0.7, ground: MANIFEST_COLORS.background },
];

const browser = await chromium.launch({ executablePath: values.browser ?? '/usr/bin/google-chrome' });
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const icon of ICONS) {
    const side = Math.round(icon.size * icon.scale);
    await page.setViewportSize({ width: icon.size, height: icon.size });
    await page.setContent(
      `<!doctype html><html><body style="margin:0;width:${icon.size}px;height:${icon.size}px;display:grid;place-items:center;background:${icon.ground ?? 'transparent'}">` +
        `<div style="width:${side}px;height:${side}px">${mark.replace('<svg ', `<svg width="${side}" height="${side}" `)}</div></body></html>`,
    );
    writeFileSync(new URL(icon.file, out), await page.screenshot({ omitBackground: icon.ground === undefined, type: 'png' }));
    console.log(`design/pwa/${icon.file}`);
  }
} finally {
  await browser.close();
}
