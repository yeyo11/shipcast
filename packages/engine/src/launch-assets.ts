import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, normalize } from 'node:path';
import {
  CLOSING_TEXT,
  closingSlide,
  coverSlide,
  DEMO_WINDOW,
  demoOnBackdrop,
  demoSlide,
  featureSlide,
  renderCover,
  renderIllustration,
  renderOgImage,
  renderSlide,
  STORY_HEIGHT,
  storySlide,
  type OgTheme,
  type SlideImage,
} from '@shipcast/assets';
import { lookOf, PROJECTS_PATH, withCover, type Brand, type ContentPack, type LaunchConfig, type ProjectLook, type Projects } from '@shipcast/schema';
import { launchDir, projectSlug, type DraftFile } from './drafts.ts';
import type { Launch } from './registry.ts';
import type { Checkout } from './workspace.ts';

/** Where a launch's media live, as paths in the launches repo and as public URLs once deployed. */
export interface LaunchMedia {
  ogPng: string;
  ogJpeg: string;
}

/** One piece of the Instagram carousel, in order, by file name under the launch's media directory */
export interface CarouselPiece {
  file: string;
  kind: 'image' | 'video';
}

/**
 * The carousel's pieces in order: the cover, the demo as a video when launch.yml names one, one slide
 * per feature, and the closing slide. The same list builds the files and publishes them.
 */
export function carouselPieces(pack: ContentPack, config: LaunchConfig): CarouselPiece[] {
  if (!pack.instagram) return [];
  const pieces: CarouselPiece[] = [{ file: 'instagram-01.jpg', kind: 'image' }];
  if (config.assets.demo) pieces.push({ file: 'instagram-02.mp4', kind: 'video' });
  for (let i = 0; i < pack.instagram.slides.length + 1; i++) {
    pieces.push({ file: `instagram-${String(pieces.length + 1).padStart(2, '0')}.jpg`, kind: 'image' });
  }
  return pieces;
}

/** The story that goes out with the carousel */
export const STORY_FILE = 'instagram-story.jpg';

/** `launches/<project>/<ref>`, the same as the drafts; the files go under `public/`, so the blog serves them as they are. */
export function mediaDir(launch: Launch): string {
  return launchDir(launch);
}

/** The site path of a media file: what the article's front matter and the posts point to. */
export function mediaPath(launch: Launch, file: string): string {
  return `/${mediaDir(launch)}/${file}`;
}

export type BuiltAssets = { ok: true; files: DraftFile[]; media: LaunchMedia } | { ok: false; problem: string };

export interface AssetOptions {
  pack: ContentPack;
  launch: Launch;
  config: LaunchConfig;
  brand: Brand;
  checkout: Checkout;
  theme?: OgTheme;
  fetch?: typeof fetch;
  /** The brand's known projects (`projects.yml`); none listed when absent */
  projects?: Projects;
  /** `projects.yml` as it is now, so a new cover is written into it without losing the rest */
  projectsText?: string;
}

/** The site path a project's generated cover is served from */
export const coverPath = (launch: Launch) => `/covers/${projectSlug(launch.repo)}.jpg`;

/**
 * The launch's media for the drafts pull request: the OG image (PNG and JPEG) always, and the
 * Instagram carousel and story when the pack has an Instagram piece. A project without a cover, neither
 * in projects.yml nor on the site, also gets a generated one (`public/covers/<project>.jpg`) and a
 * projects.yml that points to it. A demo that is named but cannot
 * be found fails the launch: a launch that silently loses it is worse than one that stops.
 */
export async function buildAssets(options: AssetOptions): Promise<BuiltAssets> {
  const { pack, launch, brand } = options;
  const dir = `public/${mediaDir(launch)}`;
  const files: DraftFile[] = [];
  const projects = options.projects ?? {};
  const look = lookOf(projects, projectSlug(launch.repo));
  const http = options.fetch ?? globalThis.fetch;

  // The cover the project's articles and the carousel wear: listed, else already on the site, else drawn now
  let cover: SlideImage | undefined;
  if (!look.cover) {
    const path = coverPath(launch);
    cover = await image(http, `${brand.site}${path}`);
    if (!cover) {
      cover = { bytes: await renderCover(look), mimeType: 'image/jpeg' };
      files.push({ path: `public${path}`, bytes: cover.bytes });
    }
    // Listing it makes the blog show it everywhere the project appears, not only in the carousel
    files.push({ path: PROJECTS_PATH, content: withCover(options.projectsText, projects, projectSlug(launch.repo), path) });
  }

  const og = await renderOgImage(
    {
      project: pack.project.name,
      look,
      title: pack.article?.en?.title ?? pack.project.name,
      pitch: pack.article?.en?.description ?? pack.analysis.summary,
      version: pack.project.version,
      author: brand.displayName,
      site: new URL(brand.site).host,
    },
    options.theme,
  );
  files.push({ path: `${dir}/og.png`, bytes: og.png }, { path: `${dir}/og.jpg`, bytes: og.jpeg });

  if (pack.instagram) {
    const built = await buildCarousel(options, dir, look, cover);
    if (!built.ok) return built;
    files.push(...built.files);
  }

  return { ok: true, files, media: { ogPng: mediaPath(launch, 'og.png'), ogJpeg: mediaPath(launch, 'og.jpg') } };
}

async function image(http: typeof fetch, url: string): Promise<SlideImage | undefined> {
  const response = await http(url).catch(() => undefined);
  const type = response?.headers.get('content-type') ?? '';
  if (!response?.ok || !/^image\/(jpeg|png)/.test(type)) return undefined;
  return { bytes: new Uint8Array(await response.arrayBuffer()), mimeType: type.startsWith('image/png') ? 'image/png' : 'image/jpeg' };
}

/**
 * The Instagram carousel and its story, as files for the drafts pull request. The cover is the
 * project's cover (listed, served by the site or just generated), else the house illustration;
 * the closing slide carries the brand's avatar when brand.yml names one.
 */
async function buildCarousel(options: AssetOptions, dir: string, look: ProjectLook, listed: SlideImage | undefined): Promise<{ ok: true; files: DraftFile[] } | { ok: false; problem: string }> {
  const { pack, launch, config, brand, checkout } = options;
  const instagram = pack.instagram!;
  const http = options.fetch ?? globalThis.fetch;
  const project = pack.project.name;
  const site = new URL(brand.site).host;
  const title = pack.article?.en?.title ?? project;
  const cover = listed ?? (await image(http, `${brand.site}${look.cover ?? coverPath(launch)}`)) ?? {
    bytes: await renderIllustration(look),
    mimeType: 'image/png' as const,
  };
  const avatar = brand.avatar ? await image(http, brand.avatar) : undefined;
  const files: DraftFile[] = [];
  const pieces = carouselPieces(pack, config);
  const slides: Array<Parameters<typeof renderSlide>> = [
    [coverSlide({ look, project, title, summary: instagram.summary, version: pack.project.version, author: brand.displayName, site, cover }), [cover]],
    ...instagram.slides.map((slide, i): Parameters<typeof renderSlide> => [featureSlide({ look, project, index: i + 1, title: slide.title, text: slide.text }), []]),
    [closingSlide({ look, project, text: CLOSING_TEXT, author: brand.displayName, site, photo: avatar }), avatar ? [avatar] : []],
  ];
  const images = pieces.filter((p) => p.kind === 'image');
  for (const [i, piece] of images.entries()) {
    const [node, pictures] = slides[i]!;
    files.push({ path: `${dir}/${piece.file}`, bytes: (await renderSlide(node, pictures)).jpeg });
  }
  files.push({
    path: `${dir}/${STORY_FILE}`,
    bytes: (await renderSlide(storySlide({ look, project, title, version: pack.project.version, author: brand.displayName, site, cover }), [cover], STORY_HEIGHT)).jpeg,
  });

  const video = pieces.find((p) => p.kind === 'video');
  const source = config.assets.demo;
  if (video && source) {
    const work = await mkdtemp(join(tmpdir(), 'shipcast-demo-'));
    try {
      let input: string;
      if (/^https?:\/\//.test(source)) {
        const response = await http(source);
        if (!response.ok) return { ok: false, problem: `the demo ${source} answered ${response.status}` };
        input = join(work, 'demo-source');
        await writeFile(input, new Uint8Array(await response.arrayBuffer()));
      } else {
        // A path in the repo: refused if it climbs out of the clone
        const relative = normalize(source).replace(/^(\.\.(\/|\\|$))+/, '');
        input = join(checkout.hostPath, relative);
        if (relative !== normalize(source) || !existsSync(input)) {
          return { ok: false, problem: `launch.yml names the demo ${source}, which is not in the repository at ${launch.ref}` };
        }
      }
      const backdrop = join(work, 'backdrop.png');
      await writeFile(backdrop, (await renderSlide(demoSlide({ look, project, title: 'See it run', version: pack.project.version }))).png);
      const output = join(work, 'demo.mp4');
      try {
        await demoOnBackdrop(input, backdrop, DEMO_WINDOW, output);
      } catch (error) {
        return { ok: false, problem: `could not turn the demo into a video: ${error instanceof Error ? error.message : String(error)}` };
      }
      files.push({ path: `${dir}/${video.file}`, bytes: new Uint8Array(await readFile(output)) });
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }
  return { ok: true, files };
}
