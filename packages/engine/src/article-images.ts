import { ShipcastError } from '@shipcast/schema';
import type { PullRequestDraft } from './github.ts';
import { mediaKey, type MediaStore } from './media/store.ts';

/*
 * The images of an article written in the app (docs/decisions/rich-editor.md): uploaded to the media
 * store as the editor takes them, linked root-relative in the body, `![alt](/articles/<slug>/<name>)`,
 * as docs/decisions/article-images.md says, and committed with the article to the launches repo, at
 * `public/articles/<slug>/`. The name is the start of the file's sha256, so it is the same wherever
 * the bytes are uploaded again, and never a name the owner's file came with.
 */

/** An image the article's body may name: what the upload answered, and the name it goes under */
export interface ArticleImage {
  sha256: string;
  name: string;
}

const EXTENSIONS: Readonly<Record<string, string>> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

/** What an uploaded image is called in the article's folder: its sha256's first 16 characters and its type */
export function articleImageName(sha256: string, mime: string): string {
  const extension = EXTENSIONS[mime];
  if (!extension || !/^[0-9a-f]{64}$/.test(sha256)) throw new ArticleImageRefused(`an article takes PNG, JPEG, GIF or WebP images (this is ${mime})`);
  return `${sha256.slice(0, 16)}.${extension}`;
}

export const ARTICLE_IMAGE_NAME = /^[0-9a-f]{16}\.(?:png|jpg|gif|webp)$/;

export class ArticleImageRefused extends ShipcastError {
  constructor(message: string) {
    super(message, { code: 'invalid', httpStatus: 400 });
  }
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The body with each uploaded image it names linked at the article's folder, and the images it does
 * name. The page links an image under the slug its title had then: a title changed afterwards moves
 * the folder, so every root-relative link to one of these names is pointed at the folder it has now.
 */
export function placeImages(markdown: string, images: readonly ArticleImage[], dir: string): { markdown: string; used: ArticleImage[] } {
  let out = markdown;
  const used: ArticleImage[] = [];
  for (const image of images) {
    const link = new RegExp(`(\\]\\()/[^)\\s]*/${escape(image.name)}(?=[)\\s])`, 'g');
    if (!link.test(out)) continue;
    out = out.replace(link, `$1/${dir}/${image.name}`);
    used.push(image);
  }
  return { markdown: out, used };
}

/** The images' files for the article's commit, read back from the media store */
export async function articleImageFiles(used: readonly ArticleImage[], dir: string, media: Pick<MediaStore, 'get'> | undefined): Promise<PullRequestDraft['files']> {
  if (used.length === 0) return [];
  if (!media) throw new ArticleImageRefused('this process has no media store, so the article’s images cannot be read');
  const files: PullRequestDraft['files'] = [];
  for (const image of used) {
    const object = await media.get(mediaKey(image.sha256));
    if (!object) throw new ArticleImageRefused(`the image ${image.name} is not in the media store: upload it again`);
    files.push({ path: `public/${dir}/${image.name}`, bytes: object.body });
  }
  return files;
}
