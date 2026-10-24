import { readFile } from 'node:fs/promises';
import { Resvg } from '@resvg/resvg-js';
import jpeg from 'jpeg-js';
import satori from 'satori';
import { box, dots, EDITORIAL_FONTS, el, headline, INK, MUTED, projectLook, TEXT, type OgNode } from './og.ts';

/** Instagram's tallest feed format: 4:5. Every piece of a carousel shares the first one's shape. */
export const SLIDE_WIDTH = 1080;
export const SLIDE_HEIGHT = 1350;
/** A story fills the phone: 9:16 */
export const STORY_HEIGHT = 1920;

/** An image handed to Satori, which reads it from a data URL */
export interface SlideImage {
  bytes: Uint8Array;
  mimeType: 'image/jpeg' | 'image/png';
}

const dataUrl = (image: SlideImage) => `data:${image.mimeType};base64,${Buffer.from(image.bytes).toString('base64')}`;

/** The wordmark as the site sets it: first and last name, initials in the wonky italic */
const shortName = (author: string) => author.split(/\s+/).filter((_, i, all) => i === 0 || i === all.length - 1).join(' ');

const frame = (background: string, children: OgNode[], height = SLIDE_HEIGHT) =>
  box({ width: SLIDE_WIDTH, height, background, color: TEXT, fontFamily: 'Instrument Sans', position: 'relative', flexDirection: 'column' }, children);

/** The first piece, the one that stops the scroll: the article's cover with its headline on the project's colour. */
export function coverSlide(o: { project: string; title: string; summary: string; version?: string; author: string; site: string; cover: SlideImage }): OgNode {
  const { colour } = projectLook(o.project);
  return frame(INK, [
    box({ position: 'absolute', left: 0, top: 0, width: SLIDE_WIDTH, height: 900, background: colour }, [
      el('img', { width: SLIDE_WIDTH, height: 900, objectFit: 'cover', objectPosition: '75% 50%' }, undefined),
    ]),
    box({ position: 'absolute', left: 64, top: 56 }, [headline(shortName(o.author), { fontSize: 40, color: INK })]),
    box({ position: 'absolute', left: 64, right: 64, top: 620, background: colour, padding: '36px 44px 44px', flexDirection: 'column', gap: 18, border: `4px solid ${INK}` }, [
      box({ fontSize: 26, fontWeight: 600, color: INK, gap: 14 }, [el('span', {}, o.project), ...(o.version ? [el('span', {}, o.version)] : [])]),
      headline(o.title, { fontSize: o.title.length > 40 ? 68 : 80, lineHeight: 1.05, color: INK, width: '100%' }),
    ]),
    el('div', { position: 'absolute', left: 64, right: 64, top: 1010, display: 'block', fontSize: 34, lineHeight: 1.4, color: MUTED, lineClamp: 3 }, o.summary),
    box({ position: 'absolute', left: 64, right: 64, bottom: 56, justifyContent: 'space-between', alignItems: 'center', fontSize: 28, color: MUTED }, [
      el('span', {}, o.site),
      box({ color: TEXT, fontWeight: 600, alignItems: 'center', gap: 14 }, [
        el('span', {}, 'Swipe'),
        // Drawn, not typed: the subset font has no arrow
        box({ width: 44, height: 4, background: TEXT }),
        box({ width: 0, height: 0, borderTop: '10px solid transparent', borderBottom: '10px solid transparent', borderLeft: `16px solid ${TEXT}`, marginLeft: -14 }),
      ]),
    ]),
  ]);
}

/**
 * The demo's backdrop: the project's colour with the house's dots, a title above and the name below.
 * The video is laid over the window in the middle by ffmpeg (`DEMO_WINDOW`), since Satori draws stills.
 */
// Even sides: H.264 in yuv420p wants them
export const DEMO_WINDOW = { x: 64, y: 360, width: 952, height: 596 };
export function demoSlide(o: { project: string; title: string; version?: string; still?: SlideImage }): OgNode {
  const { colour } = projectLook(o.project);
  const w = DEMO_WINDOW;
  return frame(colour, [
    box({ position: 'absolute', inset: 0, ...dots(INK, 11, 1.8), opacity: 0.18 }),
    box({ position: 'absolute', left: 64, right: 64, top: 96 }, [headline(o.title, { fontSize: 96, lineHeight: 1, color: INK })]),
    // The hard offset shadow, then the window the video fills
    box({ position: 'absolute', left: w.x + 18, top: w.y + 18, width: w.width, height: w.height, background: INK }),
    box({ position: 'absolute', left: w.x - 4, top: w.y - 4, width: w.width + 8, height: w.height + 8, background: INK, border: `4px solid ${INK}` }, [
      ...(o.still ? [el('img', { width: w.width, height: w.height, objectFit: 'cover' }, undefined)] : []),
    ]),
    box({ position: 'absolute', left: 64, right: 64, bottom: 64, justifyContent: 'space-between', fontSize: 30, fontWeight: 600, color: INK }, [
      el('span', {}, o.project),
      ...(o.version ? [el('span', {}, o.version)] : []),
    ]),
  ]);
}

/** One thing the project does: a number on its colour, a headline and one sentence. */
export function featureSlide(o: { project: string; index: number; title: string; text: string }): OgNode {
  const { colour } = projectLook(o.project);
  return frame(INK, [
    box({ position: 'absolute', left: 64, right: 64, top: 0, bottom: 120, flexDirection: 'column', justifyContent: 'center', gap: 56 }, [
      box({ width: 180, height: 180, borderRadius: 90, background: colour, border: `4px solid ${TEXT}`, boxShadow: `10px 10px 0 ${TEXT}`, alignItems: 'center', justifyContent: 'center', fontFamily: 'Fraunces', fontSize: 84, color: INK }, String(o.index).padStart(2, '0')),
      box({ flexDirection: 'column', gap: 40 }, [
        headline(o.title, { fontSize: 112, lineHeight: 1.02, color: TEXT, width: '100%' }),
        box({ fontSize: 44, lineHeight: 1.4, color: MUTED }, o.text),
      ]),
    ]),
    box({ position: 'absolute', left: 64, right: 64, bottom: 64, height: 14, background: colour }),
  ]);
}

/** The last piece: where to read the rest, with the author's face. */
export function closingSlide(o: { project: string; text: string; author: string; site: string; photo?: SlideImage }): OgNode {
  const { colour } = projectLook(o.project);
  return frame(colour, [
    box({ position: 'absolute', inset: 0, ...dots(INK, 11, 1.8), opacity: 0.18 }),
    box({ position: 'absolute', left: 64, right: 64, top: 160 }, [headline(o.text, { fontSize: 110, lineHeight: 1.02, color: INK, width: '100%' })]),
    box({ position: 'absolute', left: 64, bottom: 96, alignItems: 'center', gap: 36 }, [
      ...(o.photo
        ? [
            box({ width: 220, height: 220, borderRadius: 110, border: `5px solid ${INK}`, overflow: 'hidden', boxShadow: `12px 12px 0 ${INK}` }, [
              el('img', { width: 220, height: 220, objectFit: 'cover' }, undefined),
            ]),
          ]
        : []),
      box({ flexDirection: 'column', gap: 10, color: INK }, [headline(o.author, { fontSize: 48, color: INK }), box({ fontSize: 34, fontWeight: 600 }, o.site)]),
    ]),
  ]);
}

/**
 * The story that goes out with the carousel: the cover and headline, and where to read the rest.
 * The API cannot add a link sticker, so the link lives in the bio and the story says so.
 */
export function storySlide(o: { project: string; title: string; version?: string; author: string; site: string; cover: SlideImage }): OgNode {
  const { colour } = projectLook(o.project);
  return frame(
    INK,
    [
      box({ position: 'absolute', left: 0, top: 0, width: SLIDE_WIDTH, height: 1180, background: colour }, [
        el('img', { width: SLIDE_WIDTH, height: 1180, objectFit: 'cover', objectPosition: '75% 50%' }, undefined),
      ]),
      box({ position: 'absolute', left: 64, top: 120 }, [headline(shortName(o.author), { fontSize: 44, color: INK })]),
      box({ position: 'absolute', left: 64, right: 64, top: 900, background: colour, padding: '40px 48px 48px', flexDirection: 'column', gap: 20, border: `4px solid ${INK}` }, [
        box({ fontSize: 30, fontWeight: 600, color: INK, gap: 14 }, [el('span', {}, o.project), ...(o.version ? [el('span', {}, o.version)] : [])]),
        headline(o.title, { fontSize: o.title.length > 40 ? 76 : 90, lineHeight: 1.05, color: INK, width: '100%' }),
      ]),
      box({ position: 'absolute', left: 64, right: 64, bottom: 260, flexDirection: 'column', alignItems: 'center', gap: 22 }, [
        box({ background: TEXT, color: INK, borderRadius: 999, padding: '26px 52px', fontSize: 46, fontWeight: 600 }, 'Link in bio'),
        box({ fontSize: 32, color: MUTED }, o.site),
      ]),
    ],
    STORY_HEIGHT,
  );
}

/** The text of the last slide, the same on every launch */
export const CLOSING_TEXT = 'The full write-up is in my bio';

/** Puts each `img` source in order, since the slide functions leave them for this step */
function withImages(node: OgNode, images: SlideImage[]): OgNode {
  let i = 0;
  const walk = (n: unknown): unknown => {
    if (!n || typeof n !== 'object') return n;
    const o = n as OgNode;
    const children = o.props.children;
    const props: Record<string, unknown> = { ...o.props, ...(o.type === 'img' ? { src: dataUrl(images[i++]!) } : {}) };
    if (children !== undefined) props.children = Array.isArray(children) ? children.map(walk) : walk(children);
    return { ...o, props };
  };
  return walk(node) as OgNode;
}

/** A slide as JPEG, the one image format Instagram accepts. */
export async function renderSlide(node: OgNode, images: SlideImage[] = [], height = SLIDE_HEIGHT): Promise<{ png: Uint8Array; jpeg: Uint8Array }> {
  const fonts = await Promise.all(EDITORIAL_FONTS.map(async (f) => ({ name: f.name, data: await readFile(f.path), weight: f.weight, style: f.style })));
  const svg = await satori(withImages(node, images) as never, { width: SLIDE_WIDTH, height, fonts });
  const rendered = new Resvg(svg, { fitTo: { mode: 'width', value: SLIDE_WIDTH } }).render();
  const jpg = jpeg.encode({ data: Buffer.from(rendered.pixels), width: rendered.width, height: rendered.height }, 90).data;
  return { png: new Uint8Array(rendered.asPng()), jpeg: new Uint8Array(jpg) };
}
