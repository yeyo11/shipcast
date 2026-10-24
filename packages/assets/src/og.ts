import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { Resvg } from '@resvg/resvg-js';
import jpeg from 'jpeg-js';
import satori from 'satori';

const require = createRequire(import.meta.url);

/**
 * How a brand's launch images look. Each brand brings its own (its design system decides the
 * values); the defaults are neutral placeholders until it does.
 */
export interface OgTheme {
  background: string;
  text: string;
  muted: string;
  accent: string;
  /** Font files Satori can read (TTF, OTF or WOFF; not WOFF2), regular and bold */
  font: { name: string; regular: string; bold: string };
}

export const DEFAULT_THEME: OgTheme = {
  background: '#111418',
  text: '#F2F4F5',
  muted: '#A3ACB4',
  accent: '#E8C468',
  font: {
    name: 'IBM Plex Sans',
    regular: require.resolve('@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff'),
    bold: require.resolve('@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-700-normal.woff'),
  },
};

export interface OgContent {
  /** The project's name, the image's one bold element */
  project: string;
  /** One line on what it does */
  pitch: string;
  /** The release, shown small: `v0.8.2` */
  version?: string;
  /** Who launches it: the brand's display name */
  author: string;
  /** Where it lives, shown small: `josegarrido.dev` */
  site: string;
}

export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

type Node = { type: string; props: Record<string, unknown> };
const el = (type: string, style: Record<string, unknown>, children?: unknown): Node => ({
  type,
  props: { style, ...(children === undefined ? {} : { children }) },
});

/** The layout: name large, pitch under it, release and author along the bottom edge. */
function layout(content: OgContent, theme: OgTheme): Node {
  return el(
    'div',
    {
      width: '100%',
      height: '100%',
      // Without it the padding adds to the 100% and the bottom line falls outside the image
      boxSizing: 'border-box',
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'space-between',
      padding: '72px 80px',
      background: theme.background,
      color: theme.text,
      fontFamily: theme.font.name,
    },
    [
      el('div', { display: 'flex', flexDirection: 'column' }, [
        el('div', { fontSize: content.project.length > 14 ? 88 : 112, fontWeight: 700, lineHeight: 1, letterSpacing: '-0.02em' }, content.project),
        el('div', { width: 120, height: 8, background: theme.accent, marginTop: 28, borderRadius: 4 }),
        el('div', { fontSize: 40, lineHeight: 1.3, marginTop: 36, color: theme.text, maxWidth: 960 }, content.pitch),
      ]),
      el('div', { display: 'flex', justifyContent: 'space-between', fontSize: 28, color: theme.muted }, [
        el('div', { display: 'flex' }, content.version ? `${content.author} · ${content.version}` : content.author),
        el('div', { display: 'flex' }, content.site),
      ]),
    ],
  );
}

/** The launch image as PNG (for the blog and dev.to) and JPEG (Instagram accepts nothing else). */
export async function renderOgImage(content: OgContent, theme: OgTheme = DEFAULT_THEME): Promise<{ png: Uint8Array; jpeg: Uint8Array }> {
  const [regular, bold] = await Promise.all([readFile(theme.font.regular), readFile(theme.font.bold)]);
  const svg = await satori(layout(content, theme) as never, {
    width: OG_WIDTH,
    height: OG_HEIGHT,
    fonts: [
      { name: theme.font.name, data: regular, weight: 400, style: 'normal' },
      { name: theme.font.name, data: bold, weight: 700, style: 'normal' },
    ],
  });
  const rendered = new Resvg(svg, { fitTo: { mode: 'width', value: OG_WIDTH } }).render();
  const png = new Uint8Array(rendered.asPng());
  const jpg = jpeg.encode({ data: Buffer.from(rendered.pixels), width: rendered.width, height: rendered.height }, 90).data;
  return { png, jpeg: new Uint8Array(jpg) };
}
