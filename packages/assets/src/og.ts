import { readFile } from 'node:fs/promises';
import { Resvg } from '@resvg/resvg-js';
import jpeg from 'jpeg-js';
import satori from 'satori';

export interface OgContent {
  /** The project's name: picks its colour and its drawing */
  project: string;
  /** The article's headline, set on the project's colour */
  title: string;
  /** One line on what it does */
  pitch: string;
  /** The release, shown small: `v0.8.2` */
  version?: string;
  /** Who launches it: the brand's display name */
  author: string;
  /** Where it lives, shown small: `josegarrido.dev` */
  site: string;
}

export interface OgFont {
  name: string;
  /** A static TTF, OTF or WOFF: Satori reads neither variable fonts nor WOFF2 */
  path: string;
  weight: 400 | 600;
  style: 'normal' | 'italic';
}

export type OgNode = { type: string; props: Record<string, unknown> };

/**
 * How a brand's launch images look: the fonts it needs and the layout it draws. Each brand brings
 * its own, from its design system; a company launch never wears the personal look.
 */
export interface OgTheme {
  fonts: OgFont[];
  layout(content: OgContent): OgNode;
}

export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

const el = (type: string, style: Record<string, unknown>, children?: unknown): OgNode => ({
  type,
  props: { style, ...(children === undefined ? {} : { children }) },
});
// Border-box everywhere: Satori adds padding to the width otherwise, and the drawings drift
const box = (style: Record<string, unknown>, children?: unknown) => el('div', { display: 'flex', boxSizing: 'border-box', ...style }, children);

const font = (file: string) => new URL(`../fonts/${file}`, import.meta.url).pathname;

// The personal site's editorial identity (docs/personal-identity.md): its values are the blog's
// (`src/styles/global.css` and `src/projects.ts` in the launches repo) and must move with them.
const INK = '#000000';
const TEXT = '#F5F2EA';
const MUTED = '#B8B4AA';
const PAPER = '#F7F5EF';

export type Motif = 'phone' | 'terminal' | 'label' | 'wave' | 'orb' | 'stack';
const KNOWN: Record<string, { colour: string; motif: Motif }> = {
  claudio: { colour: '#2FD7A0', motif: 'phone' },
  shipcast: { colour: '#FFD43B', motif: 'label' },
};
const SPARE_COLOURS = ['#FF6FAE', '#FF7A2F', '#7C8CFF', '#FF5A4A'];
const SPARE_MOTIFS: Motif[] = ['wave', 'orb', 'stack', 'terminal'];

function hash(text: string): number {
  let h = 0;
  for (const char of text) h = (h * 31 + char.charCodeAt(0)) >>> 0;
  return h;
}

/** The project's flat colour and drawing, picked exactly as the blog picks them */
export function projectLook(project: string): { colour: string; motif: Motif } {
  const name = project.toLowerCase();
  return (
    KNOWN[name] ?? {
      colour: SPARE_COLOURS[hash(name) % SPARE_COLOURS.length] ?? '#FF6FAE',
      motif: SPARE_MOTIFS[hash(`${name}:motif`) % SPARE_MOTIFS.length] ?? 'orb',
    }
  );
}

/** A headline in the house style: every word's first letter in Fraunces' wonky italic. */
function headline(text: string, style: Record<string, unknown>): OgNode {
  const words = text.split(/\s+/).filter(Boolean);
  return box(
    { flexWrap: 'wrap', fontFamily: 'Fraunces', ...style },
    words.map((word, i) =>
      box({ marginRight: i === words.length - 1 ? 0 : '0.22em' }, [
        el('span', { fontFamily: 'Fraunces Wonk', fontStyle: 'italic' }, word.charAt(0)),
        el('span', {}, word.slice(1)),
      ]),
    ),
  );
}

const dots = (colour: string, size = 9, dot = 1.6) => ({
  backgroundImage: `radial-gradient(circle, ${colour} ${dot}px, transparent ${dot + 0.6}px)`,
  backgroundSize: `${size}px ${size}px`,
});
const bar = (width: string, style: Record<string, unknown> = {}) => box({ width, height: 22, background: PAPER, borderRadius: 2, ...style });
const outlined = { border: `4px solid ${INK}`, boxShadow: `14px 14px 0 ${INK}` };

/** The house illustration's one bold object, in a 560 × 630 panel */
function motif(kind: Motif, colour: string): OgNode {
  const centre = { position: 'absolute', left: 280, top: 315 } as const;
  switch (kind) {
    case 'phone':
      return box({ position: 'absolute', inset: 0 }, [
        box({ position: 'absolute', left: 58, top: 190, width: 176, height: 230, background: INK, borderRadius: 10, padding: 18, flexDirection: 'column', justifyContent: 'center', gap: 20 }, [
          bar('80%', { background: colour }),
          bar('55%'),
          bar('68%'),
        ]),
        box({ ...centre, left: 220, top: 110, width: 190, height: 400, background: PAPER, ...outlined, borderRadius: 38, transform: 'rotate(-8deg)', padding: '56px 22px 0', flexDirection: 'column', gap: 22 }, [
          bar('70%', { background: INK, height: 26 }),
          bar('90%', { height: 16, ...dots(INK, 6, 1.2) }),
          bar('60%', { height: 16, ...dots(INK, 6, 1.2) }),
          box({ marginTop: 'auto', marginBottom: 48, height: 52, border: `4px solid ${INK}`, borderRadius: 12, background: colour }),
        ]),
      ]);
    case 'terminal':
      return box({ ...centre, left: 70, top: 160, width: 420, height: 300, background: INK, border: `4px solid ${PAPER}`, boxShadow: `14px 14px 0 ${PAPER}`, borderRadius: 14, transform: 'rotate(-3deg)', padding: '24px 28px', flexDirection: 'column', gap: 28 }, [
        box({ gap: 10 }, [colour, PAPER, PAPER].map((c) => box({ width: 14, height: 14, borderRadius: 7, background: c }))),
        bar('46%', { background: colour }),
        bar('72%'),
        bar('58%', { background: 'transparent', ...dots(PAPER, 7, 1.4) }),
        bar('8%', { background: colour }),
      ]);
    case 'label':
      return box({ position: 'absolute', inset: 0 }, [
        box({ position: 'absolute', left: 92, top: 222, width: 380, height: 200, background: INK, borderRadius: 18, transform: 'rotate(-10deg)' }),
        box({ position: 'absolute', left: 78, top: 208, width: 380, height: 200, background: PAPER, border: `4px solid ${INK}`, borderRadius: 18, transform: 'rotate(-10deg)', padding: '30px 110px 26px 30px', flexDirection: 'column', gap: 18 }, [
          bar('80%', { background: INK, height: 28 }),
          bar('100%', { height: 18, ...dots(INK, 6, 1.2) }),
          box({ marginTop: 'auto', height: 44, gap: 4 }, [3, 1, 4, 2, 1, 3, 2, 4, 1, 3, 2, 1].map((w) => box({ width: w * 2, background: INK }))),
          box({ position: 'absolute', right: 34, top: 74, width: 40, height: 40, borderRadius: 20, background: colour, border: `4px solid ${INK}` }),
        ]),
      ]);
    case 'wave':
      return box(
        { position: 'absolute', left: 60, top: 150, width: 440, height: 330, alignItems: 'center', justifyContent: 'space-between' },
        [30, 55, 80, 45, 95, 70, 40, 88, 60, 100, 52].map((h, i) =>
          box({ width: 26, height: `${h}%`, background: i % 3 === 0 ? INK : PAPER, border: `4px solid ${INK}`, boxShadow: `6px 6px 0 ${INK}` }),
        ),
      );
    case 'orb':
      return box({ position: 'absolute', left: 130, top: 165, width: 300, height: 300, borderRadius: 150, background: PAPER, ...outlined, overflow: 'hidden' }, [
        box({ position: 'absolute', left: 150, top: 0, width: 150, height: 300, ...dots(INK, 8, 1.6) }),
        box({ position: 'absolute', left: 66, top: 90, width: 42, height: 42, borderRadius: 21, background: INK }),
        box({ position: 'absolute', left: 180, top: 90, width: 42, height: 42, borderRadius: 21, background: INK }),
        box({ position: 'absolute', left: 90, top: 186, width: 120, height: 30, borderRadius: '0 0 40px 40px', background: colour, border: `4px solid ${INK}` }),
      ]);
    case 'stack':
      return box({ position: 'absolute', inset: 0 }, [
        box({ position: 'absolute', left: 168, top: 150, width: 250, height: 320, background: INK, border: `4px solid ${PAPER}`, transform: 'rotate(-12deg)' }),
        box({ position: 'absolute', left: 156, top: 165, width: 250, height: 320, background: PAPER, ...dots(INK, 7, 1.3), border: `4px solid ${INK}`, boxShadow: `12px 12px 0 ${INK}`, transform: 'rotate(-3deg)' }),
        box({ position: 'absolute', left: 144, top: 180, width: 250, height: 320, background: PAPER, border: `4px solid ${INK}`, transform: 'rotate(6deg)', padding: 26, flexDirection: 'column', gap: 22 }, [
          bar('60%', { background: INK, height: 34 }),
          bar('85%', { background: colour, border: `3px solid ${INK}` }),
          bar('70%', { background: INK }),
        ]),
      ]);
  }
}

/**
 * A patch of dots that fades into the field: a radial wash of the field's own colour over them, as
 * the blog does with a CSS mask, which Satori lacks. The wash is solid well before the patch's edge,
 * so the patch shows no corners, and patches never cover each other.
 */
const halftone = (box_: { left: number; top: number; size: number }, colour: string, field: string, at: string) =>
  box({ position: 'absolute', left: box_.left, top: box_.top, width: box_.size, height: box_.size }, [
    box({ position: 'absolute', inset: 0, ...dots(colour, 9, 1.7) }),
    box({ position: 'absolute', inset: 0, backgroundImage: `radial-gradient(circle at ${at}, transparent 0%, transparent 18%, ${field} 70%)` }),
  ]);

/** The house illustration: a flat field of the project's colour, halftone dots and one object. */
function illustration(colour: string, kind: Motif): OgNode {
  return box({ position: 'relative', width: 560, height: OG_HEIGHT, background: colour, overflow: 'hidden' }, [
    // The dots gather in the lower right, as on the blog, where the light is gone
    halftone({ left: 160, top: 230, size: 400 }, INK, colour, '100% 100%'),
    halftone({ left: 0, top: 0, size: 320 }, 'rgba(255,255,255,0.85)', colour, '0% 0%'),
    motif(kind, colour),
  ]);
}

/** The personal brand's launch image: the headline on the project's colour, beside its drawing. */
export const EDITORIAL_THEME: OgTheme = {
  fonts: [
    { name: 'Fraunces', path: font('Fraunces-Roman.ttf'), weight: 400, style: 'normal' },
    { name: 'Fraunces Wonk', path: font('Fraunces-WonkItalic.ttf'), weight: 400, style: 'italic' },
    { name: 'Instrument Sans', path: font('InstrumentSans-Regular.ttf'), weight: 400, style: 'normal' },
    { name: 'Instrument Sans', path: font('InstrumentSans-SemiBold.ttf'), weight: 600, style: 'normal' },
  ],
  layout(content) {
    const { colour, motif: kind } = projectLook(content.project);
    const long = content.title.length > 48;
    return box({ width: '100%', height: '100%', background: INK, color: TEXT, fontFamily: 'Instrument Sans' }, [
      box({ width: 640, height: '100%', boxSizing: 'border-box', padding: '52px 56px 48px', flexDirection: 'column', justifyContent: 'space-between' }, [
        headline(content.author.split(/\s+/).filter((_, i, all) => i === 0 || i === all.length - 1).join(' '), { fontSize: 30, color: TEXT }),
        box({ flexDirection: 'column', gap: 26 }, [
          box({ background: colour, padding: '22px 28px 26px', flexDirection: 'column', width: 528 }, [
            headline(content.title, { fontSize: long ? 46 : 58, lineHeight: 1.08, color: INK, letterSpacing: '-0.01em', width: '100%' }),
          ]),
          el('div', { display: 'block', fontSize: 24, lineHeight: 1.4, color: MUTED, width: 520, lineClamp: 2 }, content.pitch),
        ]),
        box({ fontSize: 20, fontWeight: 600, color: MUTED, gap: 14 }, [
          ...(content.version ? [el('span', { color: TEXT }, content.version)] : []),
          el('span', {}, content.site),
        ]),
      ]),
      illustration(colour, kind),
    ]);
  },
};

export const DEFAULT_THEME = EDITORIAL_THEME;

/** The launch image as PNG (for the blog and dev.to) and JPEG (Instagram accepts nothing else). */
export async function renderOgImage(content: OgContent, theme: OgTheme = DEFAULT_THEME): Promise<{ png: Uint8Array; jpeg: Uint8Array }> {
  const fonts = await Promise.all(theme.fonts.map(async (f) => ({ name: f.name, data: await readFile(f.path), weight: f.weight, style: f.style })));
  const svg = await satori(theme.layout(content) as never, { width: OG_WIDTH, height: OG_HEIGHT, fonts });
  const rendered = new Resvg(svg, { fitTo: { mode: 'width', value: OG_WIDTH } }).render();
  const png = new Uint8Array(rendered.asPng());
  const jpg = jpeg.encode({ data: Buffer.from(rendered.pixels), width: rendered.width, height: rendered.height }, 90).data;
  return { png, jpeg: new Uint8Array(jpg) };
}
