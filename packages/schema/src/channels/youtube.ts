import { HOURLY_BATCHED, WEEKEND, WORKDAYS, type ChannelDefinition, type PieceKit } from './definition.ts';

/*
 * YouTube: two videos a launch, a vertical Short and a horizontal video, drawn by packages/assets from
 * what the launch has (its demo, screenshots and cover) and the scene script the pack writes for each.
 * The pure half; its adapter is packages/runtime/src/channels/youtube.ts, its run
 * packages/engine/src/publishing/youtube.ts.
 */

const limits = { youtubeTitle: 100, youtubeDescription: 5000, youtubeTags: 15, youtubeShortSeconds: 59, youtubeVideoMin: 60, youtubeVideoMax: 180 } as const;

/** The two videos, by their part: the draft file's suffix and the piece's key */
export const YOUTUBE_VIDEOS = ['short', 'video'] as const;
export type YouTubeVideoPart = (typeof YOUTUBE_VIDEOS)[number];

/** One scene of a video's script, as the pack writes it and the renderer draws it */
export interface YouTubeScene {
  /** A card in the brand's look, the project's demo, one of its screenshots (by its place, from 1), or its cover */
  kind: 'card' | 'demo' | 'screenshot' | 'cover';
  title?: string;
  text?: string;
  /** The line burned in as the subtitle, and its caption: the video has no voice */
  subtitle: string;
  /** How long it stays; a demo is cut at it */
  seconds: number;
  /** The screenshot it shows, from 1, for a `screenshot` scene */
  screenshot?: number;
  /** A chapter of the horizontal video starting here */
  chapter?: string;
}

export interface YouTubeVideoPiece {
  title: string;
  description: string;
  tags: string[];
  lang: 'en' | 'es';
  scenes: YouTubeScene[];
}

export interface YouTubePiece {
  short: YouTubeVideoPiece;
  video: YouTubeVideoPiece;
}

/** How long a script lasts, as the renderer will make it */
export const scriptSeconds = (scenes: readonly Pick<YouTubeScene, 'seconds'>[]) => scenes.reduce((sum, s) => sum + s.seconds, 0);

const piece = ({ z, Language }: PieceKit) => {
  const Scene = z.strictObject({
    kind: z.enum(['card', 'demo', 'screenshot', 'cover']).describe('A card with a title and a few words, the demo, a screenshot, or the cover'),
    title: z.string().min(1).max(80).optional().describe("A card's title"),
    text: z.string().min(1).max(160).optional().describe("A card's few words"),
    subtitle: z.string().min(1).max(120).describe('The line shown as the subtitle: the narration, since there is no voice'),
    seconds: z.number().min(2).max(30),
    screenshot: z.number().int().min(1).optional().describe('Which screenshot, from 1, for a screenshot scene'),
    chapter: z.string().min(1).max(60).optional().describe('Starts a chapter of the horizontal video here'),
  });
  const Video = (what: string, min: number, max: number) =>
    z
      .strictObject({
        title: z.string().min(1).max(limits.youtubeTitle),
        description: z.string().min(1).max(limits.youtubeDescription - 400).describe('What the video shows, plain; the article link and the chapters are added before and after it'),
        tags: z.array(z.string().min(1).max(30)).max(limits.youtubeTags),
        lang: Language,
        scenes: z.array(Scene).min(2),
      })
      .refine((v) => scriptSeconds(v.scenes) >= min && scriptSeconds(v.scenes) <= max, `the scenes of ${what} last ${min} to ${max} seconds in all`)
      .describe(what);
  return z
    .strictObject({
      short: Video('the vertical Short', 6, limits.youtubeShortSeconds),
      video: Video('the horizontal video', limits.youtubeVideoMin, limits.youtubeVideoMax),
    })
    .optional()
    .describe('Two videos with no voice, drawn from the launch: a vertical Short and a horizontal video with chapters');
};

/** The draft of one video: its title and tags on their lines, the description, then its script to read */
export function youtubeDraft(video: YouTubeVideoPiece): string {
  const scenes = video.scenes.map((s, i) => `${i + 1}. ${s.kind}${s.title ? `, ${s.title}` : ''} (${s.seconds} s): ${s.subtitle}`);
  return [`Title: ${video.title}`, `Tags: ${video.tags.map((t) => `\`${t}\``).join(', ')}`, '', '---', '', video.description.trim(), '', '---', '', 'Scenes (drawn into the video; change them in pack.json):', '', ...scenes].join('\n');
}

/** A video's draft as edited: the title, tags and description, each falling back to the pack's */
export function parseYouTubeDraft(body: string, fallback: Pick<YouTubeVideoPiece, 'title' | 'description' | 'tags'>): { title: string; description: string; tags: string[] } {
  const [head = '', description, ...rest] = body.split(/^---$/m);
  const title = /^Title: (.+)$/m.exec(head)?.[1]?.trim() || fallback.title;
  const tagLine = /^Tags: (.*)$/m.exec(head)?.[1];
  const tags = tagLine === undefined ? fallback.tags : (tagLine.match(/`([^`]+)`/g) ?? []).map((t) => t.slice(1, -1));
  // A draft whose script part was removed keeps all that follows the head as the description
  const text = (rest.length > 0 ? description : [description, ...rest].join('---'))?.trim();
  return { title, description: text || fallback.description, tags };
}

const DRAFT = /^youtube-(short|video)\.md$/;
const FILE_TITLE: Record<YouTubeVideoPart, string> = { short: 'YouTube, the Short', video: 'YouTube, the video' };

export const youtube = {
  id: 'youtube',
  name: 'YouTube',
  inSentence: 'YouTube',
  icon: 'youtube',
  defaultMode: 'off',
  group: 'social',
  publishedBy: 'engine',
  // An upload whose answer was lost may have made the video: never sent again on its own
  idempotent: false,
  // Its launch is two videos, and a schedule is one row per channel
  schedulable: false,
  pack: {
    key: 'youtube',
    piece,
    // A comment answers the horizontal video, the one with the whole walk-through
    postText: (p: YouTubePiece) => `${p.video.title}\n\n${p.video.description}`,
  },
  brief:
    'youtube: two videos with no voice, each a title of at most {{limit.youtubeTitle}} characters, a description, up to {{limit.youtubeTags}} tags and its language: `short`, a vertical Short of at most {{limit.youtubeShortSeconds}} seconds in all, and `video`, a horizontal video of {{limit.youtubeVideoMin}} to {{limit.youtubeVideoMax}} seconds with three or more scenes that start a `chapter` (the first at the start). Each is a script of scenes Shipcast draws: `card` (a title and a few words in the brand\'s look), `demo` (the project\'s recording), `screenshot` (by its place, from 1) or `cover`, each with the `subtitle` shown over it, which is the narration. Show only what the analysis lists as implemented: a planned feature is never on screen or in a subtitle. The description says what the video shows; do not add the article\'s link or the chapters, Shipcast puts the link first and the chapters after it.',
  adapt: 'a video description: what it shows, plain, the link first',
  draft: {
    file: (part: string) => ({ name: `youtube-${part}.md`, title: FILE_TITLE[part as YouTubeVideoPart] ?? `YouTube, ${part}` }),
    match: (name: string) => DRAFT.exec(name)?.[1],
    read: (body: string) => {
      const video = parseYouTubeDraft(body, { title: '', description: '', tags: [] });
      return { text: video.description, title: video.title };
    },
    write: (p: YouTubePiece) => YOUTUBE_VIDEOS.map((part) => ({ part, body: youtubeDraft(p[part]) })),
  },
  limits,
  edit: {
    edit: 'yes',
    delete: 'yes',
    note: 'The title, description and tags of each video change in place; the video itself cannot be replaced, only deleted',
    fields: ['text', 'title', 'tags'],
    main: 'post:*',
    fieldNames: { text: 'the description' },
  },
  comments: { read: true, reply: true, note: 'The comments under each video, and replies in their thread (youtube.force-ssl)', replyLimit: 500 },
  profile: {
    read: true,
    edit: 'yes',
    fields: ['displayName', 'bio', 'links', 'avatar'],
    editable: ['bio', 'links'],
    // The links are the channel's settings: `Keywords` (500 characters), `Country` (two letters) and `Trailer` (one of its videos)
    limits: { displayName: 100, bio: 1000, links: { count: 3, name: 8, value: 500 } },
    note: 'The description changes here, and the keywords, country and trailer as the links `Keywords: …`, `Country: ES`, `Trailer: <video>`; the name, the picture and the banner are changed in YouTube Studio',
  },
  posting: {
    note: 'weekday afternoons and the weekend morning, when developers watch rather than skim',
    windows: [
      { days: WORKDAYS, from: 14, to: 17, weight: 1 },
      { days: WEEKEND, from: 9, to: 12, weight: 0.8 },
    ],
  },
  metrics: {
    families: { views: ['views'], reactions: ['likes'], comments: ['comments'], shares: ['shares'] },
    primary: ['views', 'likes'],
    cadence: HOURLY_BATCHED,
    // YouTube Analytics (watch time, engaged views, shares): Google's numbers lag 48 to 72 hours
    analytics: { hours: 24, read: 'single', why: 'YouTube Analytics lags 48–72 hours' },
  },
  // No slot of its own: its brand is red, which in Cartel only means failure; it takes the first free one
} as const satisfies ChannelDefinition<'youtube'>;
