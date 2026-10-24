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

const URL_PATTERN = /https?:\/\/\S+/i;

/** Limits each network enforces, checked here so a pack that would be rejected never reaches review. */
export const LIMITS = {
  articleDescription: 200,
  devtoTags: 4,
  blueskyGraphemes: 300,
  mastodonCharacters: 500,
  instagramCaption: 2200,
  instagramHashtags: 30,
  redditTitle: 300,
  newsletterSubject: 90,
  newsletterPreview: 140,
} as const;

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
      'The article body in Markdown, without front matter and without a top-level heading. For a launch: the problem, the solution, how it works, a quick start, limitations and next steps.',
    ),
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
    limitations: z.array(z.string().min(1)).describe('Known limits a reader should hear about before trying it'),
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
        media: z
          .enum(['og-image', 'demo-video'])
          .describe('og-image: the generated launch image; demo-video: the demo GIF converted to a Reel'),
      })
      .optional(),
    reddit: z
      .array(
        z.strictObject({
          subreddit: z.string().regex(/^[A-Za-z0-9_]{2,21}$/).optional().describe('Without r/; suggest one when none is configured'),
          title: z.string().min(1).max(LIMITS.redditTitle),
          body: z
            .string()
            .min(1)
            .describe("Markdown, written for that community's rules: what you built and why, not an ad"),
        }),
      )
      .optional()
      .describe('Drafts the owner posts by hand, one per subreddit'),
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

/** The pieces the pack schema can carry today, by channel. */
const PIECE_OF: Partial<Record<Channel, keyof ContentPack>> = {
  blog: 'article',
  devto: 'devto',
  bluesky: 'bluesky',
  mastodon: 'mastodon',
  instagram: 'instagram',
  reddit: 'reddit',
  newsletter: 'newsletter',
};

/**
 * What the pack lacks for the channels this launch turns on: a valid pack can still be incomplete,
 * since each piece is optional so that one schema serves every launch.yml.
 */
export function missingPieces(pack: ContentPack, config: LaunchConfig, brand: Brand): string[] {
  const missing: string[] = [];

  for (const channel of activeChannels(config)) {
    const piece = PIECE_OF[channel];
    if (!piece) {
      missing.push(`${channel}: no connector yet; set it to off in launch.yml`);
      continue;
    }
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

/** The JSON Schema handed to Claude, so the pack comes back in this shape. */
export function contentPackJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(ContentPack, { target: 'draft-2020-12', io: 'input' }) as Record<string, unknown>;
}
