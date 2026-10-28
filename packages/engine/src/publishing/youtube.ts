import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chapterLines, durationSeconds, renderVideo, type Scene, type VideoFormat, type VideoRequest } from '@shipcast/assets';
import { planScreenshots } from '@shipcast/capture';
import { ConnectorError, type YouTubePublished, type YouTubeVideo } from '@shipcast/connectors';
import { draftBody, draftFile, lookOf, parseYouTubeDraft, YOUTUBE_VIDEOS, type YouTubePiece, type YouTubeScene, type YouTubeVideoPart } from '@shipcast/schema';
import { isArticle, projectLabel, projectSlug } from '../drafts.ts';
import { loadProjects } from '../pipeline.ts';
import type { PublishContext, PublishStrategy } from '../publish.ts';
import type { Post } from '../registry.ts';

/*
 * How a launch goes out on YouTube: its two videos rendered here, on the worker that publishes, from
 * what the launch has on the site (its demo, its screenshots, its cover) and the scene script of the
 * pack's `youtube` piece, then uploaded with their captions and the cover as the thumbnail. Each video
 * is a piece of its own (`post:short`, `post:video`), recorded the moment it is up.
 */

/** What the run needs of the connector: packages/connectors' YouTube, behind the adapter's quota check */
export interface YouTubePublisher {
  publish(video: YouTubeVideo): Promise<YouTubePublished>;
}

/** What Google does with an unaudited project's uploads, said as the launch page says it: not a failure */
export const PRIVATE_UNTIL_AUDIT = 'private until Google audits the project';

/** Where a video's privacy after its upload is kept, when it is not what was asked */
export const youtubePrivacyKey = (postId: number) => `youtube-privacy:${postId}`;

/** A video's piece: each of the two is the post's own piece, edited and read like a post */
export const youtubeKind = (part: YouTubeVideoPart): Post['kind'] => `post:${part}`;

const FORMAT: Record<YouTubeVideoPart, VideoFormat> = { short: 'short', video: 'horizontal' };
const CAPTION_NAME = { en: 'English', es: 'Español' } as const;
const DESCRIPTION_MAX = 5000;

export interface YouTubeStrategyOptions {
  /** The renderer; packages/assets' ffmpeg one by default, a fake in tests that need no video */
  render?: (request: VideoRequest) => Promise<{ srt: string; chapters: Array<{ at: number; title: string }> }>;
  /** A media file's length, for a demo shorter than its scene; ffprobe by default */
  duration?: (file: string) => Promise<number>;
  ffmpeg?: string;
  ffprobe?: string;
}

/** The launch's media as the renderer takes them, fetched from the site into a work folder */
interface Media {
  cover: { bytes: Uint8Array; mimeType: 'image/png' | 'image/jpeg' };
  screenshots: Array<{ bytes: Uint8Array; mimeType: 'image/png' | 'image/jpeg' }>;
  demo: string | undefined;
}

async function fetched(context: PublishContext, file: string): Promise<{ bytes: Uint8Array; type: string } | undefined> {
  const response = await context.fetch(context.mediaUrl(file)).catch(() => undefined);
  if (!response?.ok) return undefined;
  return { bytes: new Uint8Array(await response.arrayBuffer()), type: response.headers.get('content-type') ?? '' };
}

/**
 * The cover (the launch image), the screenshots the launch captured and its demo, as the site serves
 * them: the demo the repo's recording turned into (`demo.gif`), else the carousel's video of it.
 */
async function launchMedia(context: PublishContext, work: string): Promise<Media> {
  const png = await fetched(context, 'og.png');
  const cover = png?.type.startsWith('image/png') ? { bytes: png.bytes, mimeType: 'image/png' as const } : { bytes: await context.image(), mimeType: 'image/jpeg' as const };
  const screenshots: Media['screenshots'] = [];
  // The pages launch.yml has screenshotted, desktop ones first: they fill a horizontal frame, and a
  // Short fits them as it fits any image; with no site in launch.yml there are none
  if (context.config.assets.site) {
    const names = planScreenshots(context.config.assets.screenshots).map((p) => p.name);
    for (const file of [...names.map((n) => `${n}-desktop.png`), ...names.map((n) => `${n}-mobile.png`)]) {
      const shot = await fetched(context, `screenshots/${file}`);
      if (shot?.type.startsWith('image/png')) screenshots.push({ bytes: shot.bytes, mimeType: 'image/png' });
    }
  }
  let demo: string | undefined;
  for (const file of ['demo.gif', 'instagram-02.mp4']) {
    const found = await fetched(context, file);
    if (!found) continue;
    demo = join(work, file);
    await writeFile(demo, found.bytes);
    break;
  }
  return { cover, screenshots, demo };
}

/**
 * The script as the renderer draws it. A demo shorter than its scene plays once and the time it
 * leaves goes to the next scene, so the video lasts what the script says (YouTube's limits are on
 * the whole); a screenshot or a demo the launch lacks is the cover instead.
 */
async function scenesOf(script: readonly YouTubeScene[], media: Media, duration: (file: string) => Promise<number>, project: string): Promise<Scene[]> {
  const scenes: Scene[] = [];
  let carried = 0;
  for (const s of script) {
    const seconds = s.seconds + carried;
    carried = 0;
    const chapter = s.chapter ? { chapter: s.chapter } : {};
    if (s.kind === 'card') {
      scenes.push({ kind: 'card', title: s.title ?? project, ...(s.text && { text: s.text }), subtitle: s.subtitle, seconds, ...chapter });
    } else if (s.kind === 'demo' && media.demo) {
      const length = Math.min(seconds, await duration(media.demo));
      carried = seconds - length;
      scenes.push({ kind: 'demo', file: media.demo, subtitle: s.subtitle, maxSeconds: length, ...chapter });
    } else {
      const image = s.kind === 'screenshot' ? (media.screenshots[(s.screenshot ?? 1) - 1] ?? media.screenshots[0] ?? media.cover) : media.cover;
      scenes.push({ kind: 'image', image, subtitle: s.subtitle, seconds, ...chapter });
    }
  }
  // Time a demo left at the very end goes to the scene before it, which can hold a still
  const last = scenes.at(-1);
  if (carried > 0 && last && last.kind !== 'demo') last.seconds += carried;
  return scenes;
}

/** The description as uploaded: the article first, what the video shows, then the horizontal video's chapters */
function description(context: PublishContext, text: string, chapters: Array<{ at: number; title: string }>): string {
  const link = `${context.articleUrl}?ref=youtube`;
  // YouTube shows chapters only from three, the first at 0:00
  const list = chapters.length >= 3 && chapters[0]?.at === 0 ? `\n\n${chapterLines(chapters)}` : '';
  const room = DESCRIPTION_MAX - link.length - list.length - 2;
  return `${link}\n\n${text.trim().slice(0, room)}${list}`;
}

export function youtubeStrategy(options: YouTubeStrategyOptions = {}): PublishStrategy<YouTubePublisher> {
  const render = options.render ?? ((request: VideoRequest) => renderVideo({ ...request, ...(options.ffmpeg && { ffmpeg: options.ffmpeg }), ...(options.ffprobe && { ffprobe: options.ffprobe }) }));
  const duration = options.duration ?? ((file: string) => durationSeconds(file, options.ffprobe));
  return {
    done(pieces, { pack }) {
      return pack.youtube !== undefined && YOUTUBE_VIDEOS.every((part) => pieces.some((p) => p.channel === 'youtube' && p.kind === youtubeKind(part)));
    },
    run(context, publisher) {
      const piece: YouTubePiece | undefined = context.pack.youtube;
      if (!piece) return undefined;
      return async () => {
        const left = YOUTUBE_VIDEOS.filter((part) => !context.pieces.some((p) => p.channel === 'youtube' && p.kind === youtubeKind(part)));
        const work = await mkdtemp(join(tmpdir(), 'shipcast-youtube-'));
        const failures: ConnectorError[] = [];
        try {
          const media = await launchMedia(context, work);
          const projects = await loadProjects(context.github, context.launchesRepo);
          const look = lookOf(projects, isArticle(context.launch) ? context.launch.ref : projectSlug(context.launch.repo));
          const project = projectLabel(context.pack, context.launch) ?? context.title;
          for (const part of left) {
            const video = piece[part];
            const draft = await context.read(`${context.dir}/${draftFile('youtube', part).name}`);
            const edited = draft === undefined ? video : { ...video, ...parseYouTubeDraft(draftBody(draft), video) };
            const output = join(work, `${part}.mp4`);
            let upload: YouTubeVideo;
            try {
              const rendered = await render({
                format: FORMAT[part],
                look,
                project,
                ...(context.pack.project.version && { version: context.pack.project.version }),
                author: context.brand.displayName,
                site: new URL(context.brand.site).host,
                scenes: await scenesOf(video.scenes, media, duration, project),
                output,
              });
              upload = {
                title: edited.title,
                description: description(context, edited.description, part === 'video' ? rendered.chapters : []),
                tags: edited.tags,
                lang: video.lang,
                bytes: new Uint8Array(await readFile(output)),
                short: part === 'short',
                privacy: 'public',
                captions: [{ lang: video.lang, name: CAPTION_NAME[video.lang], srt: rendered.srt }],
                thumbnail: media.cover,
              };
            } catch (error) {
              // A script the renderer refuses fails the same way the next time: the owner fixes the pack
              failures.push(new ConnectorError('YouTube', `render the ${part}: ${error instanceof Error ? error.message : String(error)}`, undefined, false));
              continue;
            }
            try {
              const published = await publisher.publish(upload);
              // Recorded at once: the other video failing must not get this one uploaded twice
              const post = await context.record({ kind: youtubeKind(part), externalId: published.externalId, url: published.url });
              if (published.privacy === 'private') {
                await context.registry.setCursor(youtubePrivacyKey(post.id), PRIVATE_UNTIL_AUDIT);
                context.note(`the ${part} is ${PRIVATE_UNTIL_AUDIT}`);
              }
              for (const extra of published.extras) context.note(`the ${part}'s ${extra}`);
            } catch (error) {
              failures.push(error instanceof ConnectorError ? error : new ConnectorError('YouTube', error instanceof Error ? error.message : String(error)));
            }
          }
        } finally {
          await rm(work, { recursive: true, force: true });
        }
        if (failures.length > 0) {
          // Tried again only when every failure can be, as Reddit's subreddits are
          throw new ConnectorError('YouTube', failures.map((f) => f.message.replace(/^YouTube: /, '')).join('; '), undefined, failures.every((f) => f.retryable));
        }
        return undefined;
      };
    },
  };
}
