/*
 * The editor's images (docs/decisions/rich-editor.md): uploaded to the media store as soon as they are
 * pasted, dropped or chosen, linked root-relative in the Markdown, and described before the text can
 * be saved. Pure but for the upload, so the tests read the Markdown parts without a browser.
 */

/** What a surface that takes images gives the editor */
export interface ImageSupport {
  /** Uploads a file and answers the address to link it at, or why it was not taken */
  upload(file: File): Promise<{ ok: true; src: string } | { ok: false; problem: string }>;
  /** Where the page can show an image the Markdown links (an upload the site does not have yet) */
  display(src: string): string;
}

/** The blog's cap on alt text, as for the launch image (`imageAlt`) */
export const ALT_MAX = 140;

export type Uploaded = { ok: true; file: { sha256: string; mime: string; articleName: string } } | { ok: false; problem: string };

/** The file's bytes as the body (routes/api/sources/media.ts): the server checks its size and type before taking it */
export async function uploadImage(file: File): Promise<Uploaded> {
  try {
    const response = await fetch('/api/sources/media', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file });
    if ((response.headers.get('content-type') ?? '').includes('json')) return (await response.json()) as Uploaded;
    return { ok: false, problem: (await response.text()) || `the upload answered ${response.status}` };
  } catch (error) {
    return { ok: false, problem: error instanceof Error ? error.message : String(error) };
  }
}

/** The images a file list holds: what a paste or a drop brings that the editor takes */
export const imageFiles = (files: readonly File[]): File[] => files.filter((f) => /^image\/(png|jpeg|gif|webp)$/.test(f.type));

const IMAGE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

/** The images of a text without alt text, where each starts: what the editor asks to describe */
export function imagesWithoutAlt(markdown: string): Array<{ at: number; src: string }> {
  const out: Array<{ at: number; src: string }> = [];
  for (const match of markdown.matchAll(IMAGE)) if (!match[1]!.trim()) out.push({ at: match.index, src: match[2]! });
  return out;
}

/** The text with the image that starts at `at` described */
export function describeImage(markdown: string, at: number, alt: string): string {
  IMAGE.lastIndex = at;
  const match = IMAGE.exec(markdown);
  IMAGE.lastIndex = 0;
  if (!match || match.index !== at) return markdown;
  const clean = alt.replace(/[[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, ALT_MAX);
  return `${markdown.slice(0, at)}![${clean}](${match[2]})${markdown.slice(at + match[0].length)}`;
}

/**
 * The folder an article's images are linked in as it is written: `/articles/<slug of the title>`. The
 * server points every link at the folder the article really gets when it is prepared, so a title
 * changed after an image was added costs nothing.
 */
export function articleFolder(title: string): string {
  const slug = title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return `/articles/${slug || 'article'}`;
}

/** An uploaded image as the article keeps it: what the upload answered */
export interface KeptImage {
  sha256: string;
  name: string;
}

/** The images a text links, of those uploaded: what goes with the article when it is prepared */
export const linkedImages = (markdown: string, images: readonly KeptImage[]): KeptImage[] => images.filter((i) => markdown.includes(`/${i.name})`) || markdown.includes(`/${i.name} `));
