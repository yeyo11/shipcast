import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, normalize } from 'node:path';
import { demoToReel, renderOgImage, type OgTheme } from '@shipcast/assets';
import type { Brand, ContentPack, LaunchConfig } from '@shipcast/schema';
import { launchDir, type DraftFile } from './drafts.ts';
import type { Launch } from './registry.ts';
import type { Checkout } from './workspace.ts';

/** Where a launch's media live, as paths in the launches repo and as public URLs once deployed. */
export interface LaunchMedia {
  ogPng: string;
  ogJpeg: string;
  demo: string | undefined;
}

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
}

/**
 * The launch's media for the drafts pull request: the OG image (PNG and JPEG) always, and the demo
 * as a Reel when launch.yml names one. A demo that is named but cannot be found fails the launch:
 * the plan makes a demo mandatory, and a launch that silently loses it is worse than one that stops.
 */
export async function buildAssets(options: AssetOptions): Promise<BuiltAssets> {
  const { pack, launch, config, brand, checkout } = options;
  const dir = `public/${mediaDir(launch)}`;
  const files: DraftFile[] = [];

  const og = await renderOgImage(
    {
      project: pack.project.name,
      pitch: pack.article?.en?.description ?? pack.analysis.summary,
      version: pack.project.version,
      author: brand.displayName,
      site: new URL(brand.site).host,
    },
    options.theme,
  );
  files.push({ path: `${dir}/og.png`, bytes: og.png }, { path: `${dir}/og.jpg`, bytes: og.jpeg });

  let demo: string | undefined;
  const source = config.assets.demo;
  if (source) {
    const work = await mkdtemp(join(tmpdir(), 'shipcast-demo-'));
    try {
      let input: string;
      if (/^https?:\/\//.test(source)) {
        const response = await (options.fetch ?? globalThis.fetch)(source);
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
      const output = join(work, 'demo.mp4');
      try {
        await demoToReel(input, output);
      } catch (error) {
        return { ok: false, problem: `could not turn the demo into a video: ${error instanceof Error ? error.message : String(error)}` };
      }
      files.push({ path: `${dir}/demo.mp4`, bytes: new Uint8Array(await readFile(output)) });
      demo = mediaPath(launch, 'demo.mp4');
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  return { ok: true, files, media: { ogPng: mediaPath(launch, 'og.png'), ogJpeg: mediaPath(launch, 'og.jpg'), demo } };
}
