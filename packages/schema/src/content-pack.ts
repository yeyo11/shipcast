import { z } from 'zod';
import type { Brand } from './brand.ts';
import { Language, type Channel } from './channels.ts';
import { activeChannels, PackKind, type LaunchConfig } from './launch-config.ts';

const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });

/** Bluesky counts graphemes, so an emoji or an accented letter is one, as a reader sees it. */
export function graphemeCount(text: string): number {
  let count = 0;
  for (const _ of graphemes.segment(text)) count++;
  return count;
}

const utf8 = new TextEncoder();

/** Threads counts a character as one but an emoji as its UTF-8 bytes (four, or more for a joined one) */
export function threadsLength(text: string): number {
  let count = 0;
  for (const { segment } of graphemes.segment(text)) count += /\p{Extended_Pictographic}/u.test(segment) ? utf8.encode(segment).length : 1;
  return count;
}

const URL_PATTERN = /https?:\/\/\S+/i;

/** Limits each network enforces, checked here so a pack that would be rejected never reaches review. */
export const LIMITS = {
  articleDescription: 200,
  imageAlt: 140,
  devtoTags: 4,
  blueskyGraphemes: 300,
  mastodonCharacters: 500,
  instagramCaption: 2200,
  instagramHashtags: 5,
  instagramSummary: 140,
  instagramSlideTitle: 40,
  instagramSlideText: 140,
  redditTitle: 300,
  newsletterSubject: 90,
  newsletterPreview: 140,
  hashnodeTags: 5,
  /** Fits a photo caption (1024) with room for the link */
  telegramText: 900,
  discordText: 1800,
  /** GitHub takes longer titles; a discussion list shows about this much */
  githubDiscussionTitle: 120,
  githubDiscussionBody: 4000,
  threadsText: 500,
  /** LinkedIn takes 3000; a post past the "see more" fold at about 200 is read by fewer people */
  linkedinText: 1300,
} as const;

/**
 * The networks whose piece is one capped text, measured the way each network counts it: what the
 * draft editor refuses to save and the writing assistant is told, so a text the network would refuse
 * is caught before it is merged, not when it fails to publish.
 */
export const PIECE_LIMITS = {
  bluesky: { max: LIMITS.blueskyGraphemes, length: graphemeCount, network: 'Bluesky', counting: 'the link included' },
  mastodon: { max: LIMITS.mastodonCharacters, length: (t: string) => t.length, network: 'Mastodon', counting: 'the link and hashtags included' },
  threads: { max: LIMITS.threadsText, length: threadsLength, network: 'Threads', counting: 'the link included, an emoji counting as four or more' },
  telegram: { max: LIMITS.telegramText, length: (t: string) => t.length, network: 'Telegram', counting: 'the link included' },
  discord: { max: LIMITS.discordText, length: (t: string) => t.length, network: 'Discord', counting: 'the link included' },
  linkedin: { max: LIMITS.linkedinText, length: (t: string) => t.length, network: 'LinkedIn', counting: 'the hashtags included' },
} as const satisfies Partial<Record<Channel, { max: number; length: (text: string) => number; network: string; counting: string }>>;

/** What is wrong with a piece's text for its network, if anything: its length against the network's cap */
export function pieceLimitProblem(channel: string, text: string): string | undefined {
  const limit = (PIECE_LIMITS as Partial<Record<string, (typeof PIECE_LIMITS)[keyof typeof PIECE_LIMITS]>>)[channel];
  if (!limit) return undefined;
  const length = limit.length(text);
  return length > limit.max ? `${limit.network} takes at most ${limit.max} characters (${limit.counting}); this is ${length}` : undefined;
}

const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'a slug is lowercase words joined by hyphens');

const ArticleVersion = z.strictObject({
  slug: slug.describe("The article's path in this language, in this language's words: claudio-claude-code-as-a-service, claudio-claude-code-como-servicio"),
  title: z.string().min(1).max(120),
  description: z
    .string()
    .min(1)
    .max(LIMITS.articleDescription)
    .describe('One or two sentences for the index, the meta description and the RSS feed'),
  markdown: z
    .string()
    .min(1)
    .describe(
      'The article body in Markdown, without front matter and without a top-level heading. It opens with one or two sentences that say plainly what the project is and what it does, the answer a search engine or an assistant quotes. For a launch: the problem, the solution, how it works, a quick start and next steps, with headings phrased as the questions a reader asks where that reads naturally ("How do I install it?").',
    ),
  imageAlt: z
    .string()
    .min(1)
    .max(LIMITS.imageAlt)
    .optional()
    .describe("The launch image's alternative text in this language: what the image shows (the project's name, what it does), for people who cannot see it and for search"),
});

const NewsletterIssue = z.strictObject({
  subject: z.string().min(1).max(LIMITS.newsletterSubject),
  previewText: z.string().min(1).max(LIMITS.newsletterPreview).describe('The preheader inbox apps show after the subject'),
  markdown: z
    .string()
    .min(1)
    .describe('The email body in Markdown: a short, personal note on what shipped and why it matters, linking the article; not the article itself'),
});

const Analysis = z
  .strictObject({
    summary: z.string().min(1).describe('What the project is and who it is for, in two or three sentences'),
    implemented: z
      .array(z.string().min(1))
      .min(1)
      .describe('Features that exist in the code today, each one checked against the source'),
    planned: z.array(z.string().min(1)).describe('Features the repo announces (roadmap, issues, TODOs) but the code does not have yet'),
    documentedOnly: z
      .array(z.string().min(1))
      .describe('Claims the README or docs make that the code does not back; never present these as features'),
    limitations: z.array(z.string().min(1)).describe('Known limits, for the owner reviewing the drafts; they are not written into any piece'),
  })
  .describe('What the code shows. Every piece below may only present the implemented list as working.');

export const ContentPack = z
  .strictObject({
    schemaVersion: z.literal(1),
    kind: PackKind,
    project: z.strictObject({
      name: z.string().min(1),
      repo: z.url(),
      version: z.string().optional().describe('The release tag that triggered the launch, if any'),
    }),
    analysis: Analysis,
    article: z
      .strictObject({
        tags: z.array(z.string().min(1)).max(8).default([]),
        en: ArticleVersion.optional(),
        es: ArticleVersion.optional(),
      })
      .refine((a) => a.en || a.es, 'the article needs at least one language')
      .optional()
      .describe("The blog article, the launch's canonical page; one version per language the brand's blog uses"),
    devto: z
      .strictObject({
        tags: z
          .array(z.string().regex(/^[a-z0-9]+$/, 'dev.to tags are lowercase letters and digits'))
          .min(1)
          .max(LIMITS.devtoTags),
      })
      .optional()
      .describe("dev.to republishes the English article with the blog as canonical URL; only its tags are its own"),
    hashnode: z
      .strictObject({
        tags: z
          .array(z.string().regex(/^[a-z0-9]+$/, 'Hashnode tags are lowercase letters and digits'))
          .min(1)
          .max(LIMITS.hashnodeTags),
      })
      .optional()
      .describe('Hashnode republishes the English article with the blog as the original URL; only its tags are its own'),
    telegram: z
      .strictObject({ text: z.string().min(1).max(LIMITS.telegramText) })
      .optional()
      .describe('One post in English that goes under the launch image'),
    discord: z
      .strictObject({ text: z.string().min(1).max(LIMITS.discordText) })
      .optional()
      .describe('One message in English'),
    githubDiscussions: z
      .strictObject({
        title: z.string().min(1).max(LIMITS.githubDiscussionTitle),
        body: z
          .string()
          .min(1)
          .max(LIMITS.githubDiscussionBody)
          .describe("Markdown, in English, for the people who watch the repository: what shipped and how to try it, linking the article"),
      })
      .optional()
      .describe("An announcement in the launched repo's Discussions (the Announcements category, else General)"),
    threads: z
      .strictObject({
        text: z
          .string()
          .min(1)
          .refine((t) => threadsLength(t) <= LIMITS.threadsText, `at most ${LIMITS.threadsText} characters, an emoji counting as its UTF-8 bytes`),
      })
      .optional()
      .describe('One Threads post in English that goes with the launch image, linking the article'),
    linkedin: z
      .strictObject({ text: z.string().min(1).max(LIMITS.linkedinText) })
      .optional()
      .describe("One post in English on the owner's LinkedIn profile, sharing the article as its link card"),
    bluesky: z
      .strictObject({
        lang: Language,
        text: z
          .string()
          .min(1)
          .refine((t) => graphemeCount(t) <= LIMITS.blueskyGraphemes, `at most ${LIMITS.blueskyGraphemes} graphemes`),
      })
      .optional(),
    mastodon: z
      .strictObject({
        lang: Language,
        text: z.string().min(1).max(LIMITS.mastodonCharacters),
      })
      .optional(),
    instagram: z
      .strictObject({
        caption: z
          .string()
          .min(1)
          .max(LIMITS.instagramCaption)
          .refine((c) => !URL_PATTERN.test(c), 'links in an Instagram caption are not clickable: point to the link in bio')
          .refine(
            (c) => (c.match(/#[\p{L}\p{N}_]+/gu) ?? []).length <= LIMITS.instagramHashtags,
            `at most ${LIMITS.instagramHashtags} hashtags`,
          ),
        summary: z
          .string()
          .min(1)
          .max(LIMITS.instagramSummary)
          .describe("One line under the cover's headline: what the project is, for someone scrolling past"),
        slides: z
          .array(
            z.strictObject({
              title: z.string().min(1).max(LIMITS.instagramSlideTitle).describe('A few words: one thing the project does'),
              text: z.string().min(1).max(LIMITS.instagramSlideText).describe('One sentence on it, concrete'),
            }),
          )
          .min(2)
          .max(3)
          .describe('The carousel slides between the cover (and demo) and the closing one: one implemented feature each'),
      })
      .describe('A carousel: the cover, the demo as a video when there is one, these slides, and a closing slide pointing to the link in bio')
      .optional(),
    reddit: z
      .array(
        z.strictObject({
          subreddit: z.string().regex(/^[A-Za-z0-9_]{2,21}$/).describe('Without r/: one of launch.yml\'s, or one you suggest when it lists none'),
          title: z.string().min(1).max(LIMITS.redditTitle),
          body: z
            .string()
            .min(1)
            .describe("Markdown, written for that community's rules: what you built and why, not an ad; it links the article"),
        }),
      )
      .optional()
      .describe('One text post per subreddit, linking the article'),
    newsletter: z
      .strictObject({ en: NewsletterIssue.optional(), es: NewsletterIssue.optional() })
      .refine((n) => n.en || n.es, 'the issue needs at least one language')
      .optional()
      .describe("The newsletter issue, one per language the brand's newsletter has a list for"),
    releaseNotes: z.string().optional().describe('Improved release notes in Markdown, for the minor pack'),
  })
  .describe('Everything one launch publishes, written from the code of the project');

export type ContentPack = z.infer<typeof ContentPack>;

/** The URL of the article in one language, or undefined when the pack has no version in it */
export function articleUrl(pack: ContentPack, site: string, lang: 'en' | 'es'): string | undefined {
  const version = pack.article?.[lang];
  return version ? `${site}/${lang}/${version.slug}/` : undefined;
}

/**
 * The address a piece links to: the article in the first of these languages the pack has, or the
 * site's home when it has none of them (a pack without an article still links somewhere).
 */
export function articleLink(pack: ContentPack, site: string, ...langs: Array<'en' | 'es'>): string {
  for (const lang of langs) {
    const url = articleUrl(pack, site, lang);
    if (url) return url;
  }
  return site;
}

/** Each channel's piece of the pack: every channel Shipcast knows publishes one */
const PIECE_OF: Record<Channel, keyof ContentPack> = {
  blog: 'article',
  devto: 'devto',
  bluesky: 'bluesky',
  mastodon: 'mastodon',
  instagram: 'instagram',
  reddit: 'reddit',
  hashnode: 'hashnode',
  telegram: 'telegram',
  discord: 'discord',
  newsletter: 'newsletter',
  githubDiscussions: 'githubDiscussions',
  threads: 'threads',
  linkedin: 'linkedin',
};

/**
 * What the pack lacks for the channels this launch turns on: a valid pack can still be incomplete,
 * since each piece is optional so that one schema serves every launch.yml.
 */
export function missingPieces(pack: ContentPack, config: LaunchConfig, brand: Brand): string[] {
  const missing: string[] = [];

  for (const channel of activeChannels(config)) {
    const piece = PIECE_OF[channel];
    if (pack[piece] === undefined) missing.push(`${channel}: the pack has no ${piece}`);
  }

  if (config.publishing.blog !== 'off' && pack.article) {
    for (const lang of brand.languages.blog) {
      if (!pack.article[lang]) missing.push(`blog: the article has no ${lang} version`);
    }
  }
  if (config.publishing.devto !== 'off' && !pack.article?.en) {
    missing.push('devto: dev.to republishes the English article, which is missing');
  }
  if (config.publishing.hashnode !== 'off' && !pack.article?.en) {
    missing.push('hashnode: Hashnode republishes the English article, which is missing');
  }
  // The post is the article's link card: without an article there is nothing to share
  if (config.publishing.linkedin !== 'off' && pack.linkedin && !pack.article) {
    missing.push('linkedin: LinkedIn shares the article, which is missing');
  }
  if (config.publishing.reddit !== 'off' && pack.reddit) {
    const drafted = new Set(pack.reddit.map((d) => d.subreddit?.toLowerCase()));
    for (const sub of config.reddit.subreddits) {
      if (!drafted.has(sub.toLowerCase())) missing.push(`reddit: no draft for r/${sub}`);
    }
  }

  if (config.publishing.newsletter !== 'off') {
    if (!brand.newsletter) missing.push('newsletter: brand.yml has no newsletter');
    else if (pack.newsletter) {
      for (const lang of Object.keys(brand.newsletter.lists) as Array<'en' | 'es'>) {
        if (!pack.newsletter[lang]) missing.push(`newsletter: the issue has no ${lang} version`);
      }
    }
  }

  return missing;
}

/**
 * The JSON Schema handed to Claude, so the pack comes back in this shape. Draft-07, because Claude
 * Code's `--json-schema` validator refuses a schema that declares draft 2020-12.
 */
export function contentPackJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(ContentPack, { target: 'draft-7', io: 'input' }) as Record<string, unknown>;
}
