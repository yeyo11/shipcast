// Checks that tokens.css and tokens.json agree and that every text/background pair passes WCAG AA.
// Run from the repo root: node design/scripts/contrast.mjs
import { readFileSync } from 'node:fs';

const here = (p) => new URL(`../${p}`, import.meta.url);
const json = JSON.parse(readFileSync(here('tokens.json'), 'utf8')).color;
const css = readFileSync(here('tokens.css'), 'utf8');

const lum = (hex) => {
  const [r, g, b] = hex.slice(1).match(/../g).map((c) => parseInt(c, 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };

let failed = 0;
for (const theme of ['night', 'day']) {
  const block = css.split(theme === 'night' ? ':root,' : '[data-theme="day"]')[1] ?? '';
  for (const [name, hex] of Object.entries(json[theme])) {
    const m = block.match(new RegExp(`--sc-${name}:\\s*(#[0-9A-Fa-f]{6})`));
    if (!m || m[1].toUpperCase() !== hex.toUpperCase()) { failed += 1; console.log(`mismatch ${theme} ${name}: css ${m?.[1]} json ${hex}`); }
  }
}

const rows = [];
for (const theme of ['night', 'day']) {
  const t = json[theme];
  for (const bg of ['ground', 'raised']) {
    rows.push([theme, 'text', 'text', bg, 4.5], [theme, 'muted', 'muted', bg, 4.5], [theme, 'failure', 'failure', bg, 4.5], [theme, 'success', 'success', bg, 4.5], [theme, 'rail (control border)', 'rail', bg, 3]);
  }
  rows.push([theme, 'on-black', 'on-black', 'black', 4.5], [theme, 'yellow text', 'yellow', 'black', 4.5]);
  rows.push([theme, 'on-yellow', 'on-yellow', 'yellow', 4.5], [theme, 'on-yellow', 'on-yellow', 'cream', 4.5]);
  for (const r of rows.filter((x) => x[0] === theme)) r.push(t[r[2]], t[r[3]]);
}

console.log('| Theme | Foreground | Background | Ratio | Needs | Result |\n| --- | --- | --- | --- | --- | --- |');
for (const [theme, label, , bg, need, fg, bgHex] of rows) {
  const r = ratio(fg, bgHex);
  if (r < need) failed += 1;
  console.log(`| ${theme} | ${label} \`${fg}\` | ${bg} \`${bgHex}\` | ${r.toFixed(2)} | ${need} | ${r >= need ? 'pass' : 'FAIL'} |`);
}
console.log('\nDecorative only, never text or a control border: hairline.');
process.exit(failed ? 1 : 0);
