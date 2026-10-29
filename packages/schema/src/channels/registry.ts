import { blog } from './blog.ts';
import { bluesky } from './bluesky.ts';
import type { ChannelDefinition, EditField, PostingWindow, ProfileCapability, StatsMetric } from './definition.ts';
import { devto } from './devto.ts';
import { discord } from './discord.ts';
import { githubDiscussions } from './github-discussions.ts';
import { hashnode } from './hashnode.ts';
import { instagram } from './instagram.ts';
import { linkedin } from './linkedin.ts';
import { mastodon } from './mastodon.ts';
import { newsletter } from './newsletter.ts';
import { reddit } from './reddit.ts';
import { telegram } from './telegram.ts';
import { threads } from './threads.ts';
import { youtube } from './youtube.ts';

/**
 * Every channel Shipcast publishes on, each through its own connector, in the order a launch lists
 * them. Only networks Shipcast posts to itself are channels: there are no drafts for the owner to
 * post by hand (docs/decisions/automatic-channels-only.md). A new channel is its module and a line here.
 */
export const CHANNEL_DEFINITIONS = [
  blog,
  devto,
  bluesky,
  mastodon,
  instagram,
  reddit,
  hashnode,
  linkedin,
  newsletter,
  telegram,
  discord,
  githubDiscussions,
  threads,
  youtube,
] as const;

type Definitions = (typeof CHANNEL_DEFINITIONS)[number];
export type ChannelId = Definitions['id'];
/** The channels the engine publishes itself; the blog is published by the merge */
export type EngineChannelId = Extract<Definitions, { publishedBy: 'engine' }>['id'];
/** The channels whose comments are read */
export type CommentChannelId = Extract<Definitions, { comments: { read: true } }>['id'];
/** The channels "Adapt to a network" offers */
export type AdaptChannelId = Extract<Definitions, { adapt: string }>['id'];

const BY_ID: ReadonlyMap<string, ChannelDefinition> = new Map(CHANNEL_DEFINITIONS.map((d) => [d.id, d]));

/** A channel's definition; throws for an id that is not a channel, which is a bug in the caller */
export function channelDefinition(id: ChannelId): ChannelDefinition<ChannelId>;
export function channelDefinition(id: string): ChannelDefinition | undefined;
export function channelDefinition(id: string): ChannelDefinition | undefined {
  return BY_ID.get(id);
}

/** What the app and the API read of a published piece's edit and delete */
export interface Capability {
  edit: ChannelDefinition['edit']['edit'];
  delete: ChannelDefinition['edit']['delete'];
  note: string;
  fields: EditField[];
}

export interface ReplyCapability {
  read: boolean;
  reply: boolean;
  note: string;
}

export interface PieceLimit {
  max: number;
  length: (text: string) => number;
  network: string;
  counting: string;
}

/**
 * Every per-channel table, derived from a list of definitions: the exported tables below are this of
 * the registry, and the contract test runs it over the registry with a channel added, to show a new
 * channel lands in each table from its module alone.
 */
export function channelTables(definitions: readonly ChannelDefinition[]) {
  const by = <T>(pick: (d: ChannelDefinition) => T | undefined): Record<string, T> => {
    const out: Record<string, T> = {};
    for (const d of definitions) {
      const value = pick(d);
      if (value !== undefined) out[d.id] = value;
    }
    return out;
  };
  const ids = definitions.map((d) => d.id);
  return {
    ids,
    names: by((d) => d.name),
    inSentence: by((d) => d.inSentence),
    icons: by((d) => d.icon),
    defaultModes: by((d) => d.defaultMode),
    packKeys: by((d) => d.pack.key),
    longForm: ids.filter((id) => definitions.find((d) => d.id === id)!.group === 'blog'),
    publishedByEngine: definitions.filter((d) => d.publishedBy === 'engine').map((d) => d.id),
    schedulable: definitions.filter((d) => d.schedulable).map((d) => d.id),
    idempotent: definitions.filter((d) => d.idempotent).map((d) => d.id),
    capabilities: by<Capability>((d) => ({ edit: d.edit.edit, delete: d.edit.delete, note: d.edit.note, fields: [...d.edit.fields] })),
    replyCapabilities: by<ReplyCapability>((d) => d.comments && { read: d.comments.read, reply: d.comments.reply, note: d.comments.note }),
    commentChannels: definitions.filter((d) => d.comments?.read).map((d) => d.id),
    replyLimits: by((d) => (d.comments?.read ? d.comments.replyLimit : undefined)),
    profiles: by<ProfileCapability>((d) => d.profile),
    posting: by<{ note: string; windows: readonly PostingWindow[] }>((d) => d.posting),
    metricFamilies: by<Partial<Record<StatsMetric, readonly string[]>>>((d) => d.metrics?.families),
    primaryMetric: by<readonly string[]>((d) => (d.metrics && d.metrics.primary.length > 0 ? d.metrics.primary : undefined)),
    chartSlots: by<number | 'ink'>((d) => d.chartSlot),
    limits: Object.assign({}, ...definitions.map((d) => d.limits)) as Record<string, number>,
    pieceLimits: by<PieceLimit>((d) => d.text && { max: d.text.max, length: d.text.length, network: d.name, counting: d.text.counting }),
    briefs: Object.fromEntries(definitions.map((d) => [`channel.${d.id}`, d.brief])) as Record<string, string>,
    adaptTargets: by<{ name: string; limit: string }>((d) => (d.adapt ? { name: d.inSentence, limit: d.adapt } : undefined)),
    /** The channel a draft file is of, and its part: `newsletter-es.md` is the newsletter's `es` */
    draftOf(name: string): { channel: string; part: string } | undefined {
      for (const d of definitions) {
        const part = d.draft?.match(name);
        if (part !== undefined) return { channel: d.id, part };
      }
      return undefined;
    },
  };
}

const TABLES = channelTables(CHANNEL_DEFINITIONS);

export const CHANNELS = TABLES.ids as readonly ChannelId[] as readonly [ChannelId, ...ChannelId[]];

/** The canonical label of a channel; an id that is not one (a metric source, a network) stays as given */
export const channelName = (id: string): string => TABLES.names[id] ?? id;
/** A channel's name inside a sentence ("the newsletter") */
export const channelInSentence = (id: string): string => TABLES.inSentence[id] ?? id;
/** A channel's name opening a sentence ("The newsletter") */
export const channelAtStart = (id: string): string => {
  const name = channelInSentence(id);
  return name.charAt(0).toUpperCase() + name.slice(1);
};
/** The file a channel's icon is, in the design system's `icons/` folder */
export const CHANNEL_ICONS: Readonly<Record<ChannelId, string>> = TABLES.icons as Record<ChannelId, string>;
/** Each channel's piece of the content pack */
export const PACK_KEYS: Readonly<Record<ChannelId, string>> = TABLES.packKeys as Record<ChannelId, string>;
/** What a channel does when launch.yml does not mention it */
export const DEFAULT_MODES: Readonly<Record<ChannelId, ChannelDefinition['defaultMode']>> = TABLES.defaultModes as Record<ChannelId, ChannelDefinition['defaultMode']>;
/** The channels that carry an article or a newsletter rather than a short post: the Channels page's blog tab */
export const LONG_FORM_CHANNELS: readonly ChannelId[] = TABLES.longForm as ChannelId[];
/** Channels the engine publishes to itself, in the registry's order; the blog is published by the merge */
export const PUBLISHED_BY_ENGINE = TABLES.publishedByEngine as readonly EngineChannelId[];
/** The channels a time can be set for */
export const SCHEDULABLE_CHANNELS = TABLES.schedulable as readonly EngineChannelId[];
/** The channels whose run may be repeated after an answer was lost (see ChannelDefinition.idempotent) */
export const IDEMPOTENT_CHANNELS: ReadonlySet<string> = new Set(TABLES.idempotent);

/** What each channel can do with a published piece: the map the app and the API read. */
export const CAPABILITIES: Readonly<Record<ChannelId, Capability>> = TABLES.capabilities as Record<ChannelId, Capability>;
/** What each channel can do with comments */
export const REPLY_CAPABILITIES: Readonly<Record<string, ReplyCapability>> = TABLES.replyCapabilities;
/** The channels whose comments can be read */
export const COMMENT_CHANNELS = TABLES.commentChannels as readonly CommentChannelId[];
/** How long a reply may be on each network: short on purpose, under what the network itself allows */
export const REPLY_LIMITS: Readonly<Record<CommentChannelId, number>> = TABLES.replyLimits as Record<CommentChannelId, number>;
/**
 * The owner's GitHub profile, which is not a channel: read through GitHub's public API by the
 * `github` account (a login, no credential), never edited (that needs the App's "Profile: write")
 */
const GITHUB_PROFILE: ProfileCapability = {
  read: true,
  edit: 'no',
  fields: ['displayName', 'bio', 'links', 'avatar'],
  editable: [],
  limits: { bio: 160 },
  note: 'Your public GitHub profile, read; change it on GitHub',
};

/** Each network's profile; a network not listed has no profile to review (a search console) */
export const PROFILE_CAPABILITIES: Readonly<Record<string, ProfileCapability>> = { ...TABLES.profiles, github: GITHUB_PROFILE };
/** When to publish on each channel by default (packages/engine/src/recommend.ts) */
export const POSTING_DEFAULTS: Readonly<Partial<Record<ChannelId, { note: string; windows: readonly PostingWindow[] }>>> = TABLES.posting;
/** Which readings of each channel make up each stats family */
export const CHANNEL_METRIC_FAMILIES: Readonly<Record<string, Partial<Record<StatsMetric, readonly string[]>>>> = TABLES.metricFamilies;
/** The readings a piece's row leads with: the first of these the piece has */
export const PRIMARY_METRIC: Readonly<Record<string, readonly string[]>> = TABLES.primaryMetric;
/** Each channel's own slot in the charts' palette */
export const CHANNEL_SLOTS: Readonly<Record<string, number | 'ink'>> = TABLES.chartSlots;
/** Each channel's default brief, as the AI settings' `channel.<id>` prompts */
export const CHANNEL_BRIEFS = TABLES.briefs as Readonly<Record<`channel.${ChannelId}`, string>>;
/** The networks a text can be adapted to, with what their post may hold */
export const ADAPT_TARGETS = TABLES.adaptTargets as Readonly<Record<AdaptChannelId, { name: string; limit: string }>>;

/** The channel a draft file is of (`launches/<project>/<ref>/github-discussion.md`), and its part */
export function draftOf(path: string): { channel: ChannelId; part: string } | undefined {
  return TABLES.draftOf(path.split('/').at(-1) ?? path) as { channel: ChannelId; part: string } | undefined;
}

/** The file one part of a channel's piece is drafted in: `''` for a channel with one draft */
export function draftFile(channel: ChannelId, part = ''): { name: string; title: string } {
  const draft = channelDefinition(channel).draft;
  if (!draft) throw new Error(`${channel} has no draft file`);
  return draft.file(part);
}

/** A post's own piece, a blog article or a subreddit's post: what is edited and deleted (a story, a comment or an issue is not) */
export function isMainPiece(channel: string, kind: string): boolean {
  const main = channelDefinition(channel)?.edit.main ?? 'post';
  return main.endsWith('*') ? kind.startsWith(main.slice(0, -1)) : kind === main;
}

/**
 * Whether a piece of this kind has numbers of its own to read: a post, each newsletter issue (a
 * campaign of its own), and a post's own pieces where the channel's definition has metrics (each of
 * YouTube's videos; a subreddit's post has none). A story or a comment has none of its post's
 * numbers, and the blog is read per article URL for the launch, never per piece.
 */
export function readsMetrics(channel: string, kind: string): boolean {
  if (channel === 'blog') return false;
  return kind === 'post' || kind.startsWith('issue:') || (isMainPiece(channel, kind) && channelDefinition(channel)?.metrics !== undefined);
}
