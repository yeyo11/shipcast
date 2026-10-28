// A type-only import: erased at runtime, so a definition (and `@shipcast/schema/channels`) loads no
// zod in the browser. The pack's piece is a factory the main index calls with zod in hand.
import type { z } from 'zod';

/*
 * What Shipcast knows about one channel, as data: one module per channel under this folder, listed
 * once in registry.ts, and every per-channel table of the domain, the engine and the apps is derived
 * from these (docs/plans/performance-refactor.md, "One definition per channel"). This is the pure
 * half; the adapter half (the connector it is published with, its credentials and its OAuth) lives
 * in packages/runtime under the same id, since the domain does no I/O.
 */

export type ModeName = 'auto' | 'approval' | 'off';

/** What an edit can do on the network: `partial` keeps some fields as they were */
export type EditSupport = 'yes' | 'no' | 'partial';
/** `unpublish`: the network takes the piece off the site but keeps it in the author's drafts */
export type DeleteSupport = 'yes' | 'no' | 'unpublish';
/** What a change can carry; each network takes some of them */
export type EditField = 'text' | 'title' | 'tags' | 'link' | 'image';

/** The families every network's numbers are folded into, so a chart can put networks side by side */
export const STATS_METRICS = ['views', 'reactions', 'comments', 'shares', 'clicks', 'impressions'] as const;
export type StatsMetric = (typeof STATS_METRICS)[number];

export type ProfileFieldId = 'displayName' | 'bio' | 'links' | 'avatar';
/** The fields Shipcast can write; the picture is advice only */
export type EditableField = Exclude<ProfileFieldId, 'avatar'>;

/** The most a network takes in each field; `graphemes` where it counts them (Bluesky) */
export interface ProfileLimits {
  displayName?: number;
  bio?: number;
  links?: { count: number; name: number; value: number };
  graphemes?: boolean;
}

export interface ProfileCapability {
  /** Whether Shipcast reads the profile itself; without, the owner pastes it for a review */
  read: boolean;
  /** `reconnect`: the network can, but this account's credential was not granted it */
  edit: 'yes' | 'no' | 'reconnect';
  /** What the network's profile has, which is what a review may propose */
  fields: readonly ProfileFieldId[];
  /** What Shipcast can change there */
  editable: readonly EditableField[];
  limits: ProfileLimits;
  /** What the network allows or refuses, in words the app shows */
  note: string;
}

/** Monday is 0, as the posting windows are written */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** Hours [from, to) on some days, with how good they are, 0 to 1 */
export interface PostingWindow {
  days: readonly Weekday[];
  from: number;
  to: number;
  weight: number;
}

/** What a piece's schema is built with: zod, and the shapes several pieces share */
export interface PieceKit {
  z: typeof z;
  Language: z.ZodEnum<{ en: 'en'; es: 'es' }>;
}

/** The article a piece may stand for (dev.to's is the English one): what a reply is grounded in */
export interface ArticleSummary {
  title: string;
  description: string;
}

/** One draft file of a channel in the drafts pull request */
export interface DraftFileName {
  /** Its name in the launch's folder: `telegram.md`, `newsletter-en.md`, `reddit-rust.md` */
  name: string;
  /** Its heading, and its label on the review page */
  title: string;
}

export interface ChannelDefinition<Id extends string = string> {
  id: Id;
  /** The one label for the channel, wherever it is named on its own: a card, a menu, a chart */
  name: string;
  /** The same inside a sentence ("the newsletter"); the name itself where it is a proper noun */
  inSentence: string;
  /** The design system's glyph, `design/icons/<icon>.svg` */
  icon: string;
  /** What the channel does when launch.yml does not mention it */
  defaultMode: ModeName;
  /** The Channels page's tab: where short posts go, or where long writing goes */
  group: 'social' | 'blog';
  /** Who publishes it: the merge of the drafts pull request (the blog), or the engine */
  publishedBy: 'merge' | 'engine';
  /**
   * Whether a second publish after an answer that was lost is safe: the network takes an idempotency
   * key, or the connector looks for the post before sending it again. Any other channel's run cut
   * short is left for the owner to check rather than risking a second post.
   */
  idempotent: boolean;
  /** Whether a piece of it can wait for a time of the owner's choosing */
  schedulable: boolean;

  /** Its piece of the content pack */
  pack: {
    /** The pack's key: the channel's id but for the blog, whose piece is `article` */
    key: string;
    /** The piece's schema, optional in the pack (one schema serves every launch.yml) */
    piece(kit: PieceKit): z.ZodType;
    /** What the post says, from its piece: what a reply to a comment on it is grounded in */
    postText?(piece: never, article: ArticleSummary | undefined): string | undefined;
  };
  /** Its default brief, the AI settings' `channel.<id>` prompt; `{{limit.<key>}}` reads LIMITS */
  brief: string;
  /** What its post may hold, for the writing assistant's "Adapt to a network" */
  adapt?: string;

  /** Its drafts in the pull request; the blog's articles are where the blog reads them instead */
  draft?: {
    /**
     * The file of one part of its piece: `''` when it has one file, else the part (a language, a
     * subreddit) as the file name has it
     */
    file(part: string): DraftFileName;
    /** The part a file name is of, or undefined when the file is not this channel's */
    match(name: string): string | undefined;
    /** The text an edit form starts from, out of the draft's body (what follows its mode line) */
    read(body: string): { text: string; title?: string };
  };

  /** The network's own caps, by a key unique across channels: prompts read them as `{{limit.<key>}}` */
  limits: Readonly<Record<string, number>>;
  /** Its piece's one capped text, measured as the network counts it, when it has one */
  text?: {
    max: number;
    length(text: string): number;
    /** How it is counted, in words */
    counting: string;
  };

  /** What can be done with a published piece of it */
  edit: {
    edit: EditSupport;
    delete: DeleteSupport;
    /** What the network allows or refuses, in words the app shows beside the actions */
    note: string;
    /** The fields an edit can change there */
    fields: readonly EditField[];
    /** Its post's own piece: `post`, or a kind prefix ending in `*` (`article:*`, a subreddit's `post:*`) */
    main: string;
    /** Its post is text alone: a link goes after the text, so a link comes with the text */
    linkAfterText?: boolean;
    /** It replaces the text whole and cannot keep it: any change carries the text */
    textRequired?: boolean;
    /** What a field becomes there, where it is not the plain text, link or image */
    fieldNames?: Partial<Record<EditField, string>>;
    /** It carries an article: an edit's text replaces the article's whole body */
    article?: boolean;
  };
  /** Comments under its posts: whether they are read and answered here */
  comments?: {
    read: boolean;
    reply: boolean;
    note: string;
    /** How long a reply may be, under what the network allows; every channel that reads has one */
    replyLimit?: number;
    /** How the network counts a reply's length, when not by characters */
    replyLength?(text: string): number;
  };
  /** The profile of an account on it, when there is one to review */
  profile?: ProfileCapability;

  /** When to publish there by default, for a developer audience; the owner's own numbers replace it */
  posting?: { note: string; windows: readonly PostingWindow[] };
  /** Its readings, folded into the stats' families, and the ones a piece's row leads with */
  metrics?: {
    families: Partial<Record<StatsMetric, readonly string[]>>;
    /** The first of these a piece has is its row's number */
    primary: readonly string[];
  };
  /** Its series' slot in the charts' palette (`ink` for the text colour), when one is its own */
  chartSlot?: number | 'ink';
}

/** Workdays, midweek and the weekend, as the posting windows say them */
export const WORKDAYS: readonly Weekday[] = [0, 1, 2, 3, 4];
export const MIDWEEK: readonly Weekday[] = [1, 2, 3];
export const WEEKEND: readonly Weekday[] = [5, 6];
