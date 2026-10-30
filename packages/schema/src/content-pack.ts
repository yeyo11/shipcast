import { z } from 'zod';
import type { Brand } from './brand.ts';
import { Language } from './channels.ts';
import { channelTables, CHANNEL_DEFINITIONS, PACK_KEYS, type PieceLimit } from './channels/registry.ts';
import type { ChannelDefinition, PieceKit } from './channels/definition.ts';
import { activeChannels, PackKind, type LaunchConfig } from './launch-config.ts';

/** Limits each network enforces, checked here so a pack that would be rejected never reaches review: every channel's own */
export const LIMITS = Object.assign({}, ...CHANNEL_DEFINITIONS.map((d) => d.limits)) as UnionToIntersection<(typeof CHANNEL_DEFINITIONS)[number]['limits']>;

type UnionToIntersection<U> = (U extends unknown ? (u: U) => void : never) extends (i: infer I) => void ? I : never;

/**
 * The networks whose piece is one capped text, measured the way each network counts it: what the
 * draft editor refuses to save and the writing assistant is told, so a text the network would refuse
 * is caught before it is merged, not when it fails to publish.
 */
export const PIECE_LIMITS: Readonly<Record<string, PieceLimit>> = channelTables(CHANNEL_DEFINITIONS).pieceLimits;

/** What is wrong with a piece's text for its network, if anything: its length against the network's cap */
export function pieceLimitProblem(channel: string, text: string): string | undefined {
  const limit = PIECE_LIMITS[channel];
  if (!limit) return undefined;
  const length = limit.length(text);
  return length > limit.max ? `${limit.network} takes at most ${limit.max} characters (${limit.counting}); this is ${length}` : undefined;
}

type Definitions = (typeof CHANNEL_DEFINITIONS)[number];
/** Each channel's piece, under its pack key, as its definition builds it */
type Pieces = { [D in Definitions as D['pack']['key']]: ReturnType<D['pack']['piece']> };
const KIT: PieceKit = { z, Language };
const pieces = Object.fromEntries(CHANNEL_DEFINITIONS.map((d) => [d.pack.key, d.pack.piece(KIT)])) as Pieces;

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

const projectName = z.string().min(1);
const projectVersion = z.string().optional().describe('The release tag that triggered the launch, if any');

const packOf = <P extends z.ZodType>(project: P) =>
  z
    .strictObject({
      schemaVersion: z.literal(1),
      kind: PackKind,
      project,
      analysis: Analysis,
      ...pieces,
      releaseNotes: z.string().optional().describe('Improved release notes in Markdown, for the minor pack'),
    })
    .describe('Everything one launch publishes, written from the code of the project');

/**
 * A launch's pack as it is kept and read. Its repo is optional, so a launch about something with no
 * repo (a product, a talk, an opinion) has a pack too, and `repos` names the further repos a launch
 * about several is also about (docs/decisions/launch-model.md); a release's pack still names its
 * repo, which generatePack checks against the launch.
 */
export const ContentPack = packOf(
  z.strictObject({
    name: projectName,
    repo: z.url().optional().describe("The primary repo's URL: the one whose release triggered the launch; absent when the launch is about no repo"),
    repos: z.array(z.url()).optional().describe('Further repos the launch is also about, besides the primary one'),
    version: projectVersion,
  }),
);

export type ContentPack = z.infer<typeof ContentPack>;

/**
 * The pack the AI tasks are asked for: the shape they were asked for before the launch model, a repo
 * required and no further repos, so what Claude is handed does not change until the sources phase
 * gives a launch something other than a repo to be about. Every pack it accepts is a ContentPack.
 */
export const AiContentPack = packOf(z.strictObject({ name: projectName, repo: z.url(), version: projectVersion }));

/**
 * The pack's schema for a list of definitions: the registry's pack with the pieces of the channels it
 * lacks, so a test's registry with a channel added parses a pack that carries its piece.
 */
export function contentPackFor(definitions: readonly ChannelDefinition[]): z.ZodType<ContentPack> {
  const known = new Set<string>(CHANNEL_DEFINITIONS.map((d) => d.pack.key));
  const extra = definitions.filter((d) => !known.has(d.pack.key));
  return extra.length === 0 ? ContentPack : (ContentPack.extend(Object.fromEntries(extra.map((d) => [d.pack.key, d.pack.piece(KIT)]))) as unknown as z.ZodType<ContentPack>);
}

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

/**
 * What the pack lacks for the channels this launch turns on: a valid pack can still be incomplete,
 * since each piece is optional so that one schema serves every launch.yml.
 */
export function missingPieces(pack: ContentPack, config: LaunchConfig, brand: Brand): string[] {
  const missing: string[] = [];

  for (const channel of activeChannels(config)) {
    const piece = PACK_KEYS[channel] as keyof ContentPack;
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
  return z.toJSONSchema(AiContentPack, { target: 'draft-7', io: 'input' }) as Record<string, unknown>;
}
