import { createHash } from 'node:crypto';
import { imageUrl, ShipcastError } from '@shipcast/schema';

/** A connector's failure: which network, what it answered, and whether trying again could help. */
export class ConnectorError extends ShipcastError {
  readonly network: string;
  readonly status: number | undefined;
  readonly #retryable: boolean | undefined;

  /** `retryable` overrides the status, for a failure whose retry would repeat what already happened */
  constructor(network: string, message: string, status?: number, retryable?: boolean) {
    // The network's failure, not the caller's: an HTTP answer says so with 502, whatever it answered
    super(`${network}: ${message}`, { code: 'upstream', httpStatus: 502 });
    this.network = network;
    this.status = status;
    this.#retryable = retryable;
  }

  /** Rate limits and server errors pass; a refused request will be refused again */
  override get retryable(): boolean {
    return this.#retryable ?? (this.status === undefined || this.status === 429 || this.status >= 500);
  }
}

/**
 * The network says the piece itself no longer exists (deleted by hand, or by moderation): reading it
 * again will fail the same way, so the caller records it as deleted instead of trying every run.
 */
export class PostGone extends ConnectorError {
  override name = 'PostGone';

  constructor(network: string, message: string, status?: number) {
    super(network, message, status, false);
  }
}

/** A published piece: the network's own id for it, and the URL a person opens. */
export interface Published {
  externalId: string;
  url: string;
}

/** Numbers a network reports for one piece, by name (views, likes, reposts…). */
export type Metrics = Record<string, number>;

/** Reads a JSON answer, turning a non-2xx into a ConnectorError with what the network said. */
export async function json<T>(network: string, response: Response, what: string): Promise<T> {
  const text = await response.text();
  if (!response.ok) throw new ConnectorError(network, `${what}: ${response.status} ${text.slice(0, 300)}`, response.status);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ConnectorError(network, `${what}: the answer is not JSON`, response.status);
  }
}

/**
 * Whether a credential works, in words a person can act on: what the Channels page shows. A working
 * one also brings the profile's picture and name when the same answer has them.
 */
export type Check = { ok: true; account: string; avatarUrl?: string; displayName?: string } | { ok: false; problem: string };

/**
 * An account's own numbers at one moment. Each is left out where the network does not give it;
 * `extra` holds what only that network counts (a Telegram channel's members, GitHub's repos).
 */
export interface ProfileStats {
  followers?: number;
  following?: number;
  posts?: number;
  extra?: Record<string, number>;
}

// The check lives in the domain, where the app's pages use it too
export { imageUrl };

/** Keeps what is a number: networks answer null or leave a count out when it is hidden */
export function counts(values: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(values)) if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
  return out;
}

/** Profile stats from a network's answer, leaving out what it did not count */
export function statsOf(main: { followers?: unknown; following?: unknown; posts?: unknown }, extra: Record<string, unknown> = {}): ProfileStats {
  const more = counts(extra);
  return { ...counts(main), ...(Object.keys(more).length > 0 ? { extra: more } : {}) };
}

/** A working check with the profile's picture and name, each only when there is one */
export function okCheck(account: string, profile: { avatarUrl?: unknown; displayName?: unknown } = {}): Check {
  const avatarUrl = imageUrl(profile.avatarUrl);
  const displayName = typeof profile.displayName === 'string' && profile.displayName.trim() ? profile.displayName.trim() : undefined;
  return { ok: true, account, ...(avatarUrl && { avatarUrl }), ...(displayName && { displayName }) };
}

/**
 * Turns a failed check into a sentence: a status code means nothing to the person who has to fix the
 * credential, so the common answers are named for what they mean.
 */
export function checkProblem(error: unknown, rejected?: string): Check {
  if (error instanceof ConnectorError) {
    // Some networks mean something more specific by a refusal, which the connector knows best
    if (rejected && (error.status === 401 || error.status === 403)) return { ok: false, problem: rejected };
    if (error.status === 401) return { ok: false, problem: `${error.network} rejected the credential: it is wrong, revoked or expired` };
    if (error.status === 403) return { ok: false, problem: `${error.network} accepted the credential but it lacks a permission Shipcast needs` };
    if (error.status === 404) return { ok: false, problem: `${error.network} does not know that account or address` };
    if (error.status === 429) return { ok: false, problem: `${error.network} is rate limiting: try again in a few minutes` };
    if (error.status !== undefined && error.status >= 500) return { ok: false, problem: `${error.network} is having trouble (${error.status}): try again later` };
    return { ok: false, problem: error.message };
  }
  return { ok: false, problem: `could not reach the network: ${error instanceof Error ? error.message : String(error)}` };
}

/**
 * Reads an answer whose body does not matter (a 204, a commit record), turning a non-2xx into a
 * ConnectorError the way `json` does.
 */
export async function expectOk(network: string, response: Response, what: string): Promise<void> {
  if (response.ok) return;
  const text = await response.text().catch(() => '');
  throw new ConnectorError(network, `${what}: ${response.status} ${text.slice(0, 300)}`, response.status);
}

/**
 * A connector that can change a piece it published, in place. `Piece` is what that network lets
 * change; a network whose API has no edit does not implement it, so the type says so.
 */
export interface Editable<Piece> {
  edit(externalId: string, piece: Piece): Promise<void>;
}

/** A connector that can take down a piece it published (dev.to only unpublishes: it has no delete). */
export interface Deletable {
  delete(externalId: string): Promise<void>;
}

/**
 * A comment under one of the account's own posts, as the network gave it. `inReplyTo` is the parent
 * comment's id when it answers another comment; a comment on the post itself has none.
 */
export interface Comment {
  externalId: string;
  author: { handle: string; displayName?: string; avatarUrl?: string };
  /** Plain text: the networks that answer HTML have it turned into text */
  text: string;
  createdAt: string;
  inReplyTo?: string;
  /** Where a person opens it, when the network has an address for a comment */
  url?: string;
  /** Written by the account that published the post: the owner's own replies in the thread */
  own: boolean;
}

/** A connector that reads the comments under a post it published */
export interface CommentReader {
  comments(postExternalId: string): Promise<Comment[]>;
}

/** What a reply answers: the post it is under, and the comment itself */
export interface ReplyTarget {
  postExternalId: string;
  commentExternalId: string;
  /** The comment author's handle, which Mastodon needs in the text to notify them */
  authorHandle: string;
}

export interface SentReply {
  externalId: string;
  /** Instagram gives no address for a comment */
  url?: string;
}

/** A connector that can answer a comment under its own post */
export interface Replier {
  /** `key` makes a retried send a no-op on the networks that take one (Mastodon) */
  reply(target: ReplyTarget, text: string, options?: { key?: string; lang?: string }): Promise<SentReply>;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/**
 * The text of a comment a network answers as HTML (Mastodon, dev.to): paragraphs and line breaks
 * kept, tags dropped, entities decoded. It is never rendered as HTML again (the app prints it as
 * text), so nothing here has to produce safe markup.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, name: string) => {
      if (name.startsWith('#')) {
        const code = /^#x/i.test(name) ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
        // A code point out of range would throw; the entity is kept as written instead
        return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
      }
      return ENTITIES[name.toLowerCase()] ?? whole;
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** One labelled link of a profile: a Mastodon field, a website, a channel's public address */
export interface ProfileLink {
  name: string;
  value: string;
}

/**
 * An account's own profile as its network shows it: what the AI review reads and what an edit
 * changes. Text is plain (Mastodon's HTML note is read from its plain source).
 */
export interface Profile {
  displayName?: string;
  bio?: string;
  links: ProfileLink[];
  hasAvatar: boolean;
  /** Left out where the network has no banner */
  hasBanner?: boolean;
  /** Whether this credential may change the profile, when the network can say so before trying */
  editable?: { ok: true } | { ok: false; why: string };
}

/** A change to a profile; what is left out stays as it is */
export interface ProfileEdit {
  displayName?: string;
  bio?: string;
  /** The whole list, replacing the one there */
  links?: ProfileLink[];
}

/** A connector that reads the account's own profile */
export interface ProfileReader {
  profile(): Promise<Profile>;
}

/** A connector that changes the account's own profile (Mastodon, Bluesky, a Telegram channel) */
export interface ProfileEditor {
  editProfile(edit: ProfileEdit): Promise<void>;
}

/**
 * Where an account's identity (its own id, its username, a session) is kept between runs, so the
 * hourly reads do not ask for it again each time: the runtime's Cache (Redis, or a process's memory)
 * satisfies it without an import upward. Values are strings; a connector encodes what it keeps.
 */
export interface IdentityCache {
  remember<T extends string>(key: string, ttlSeconds: number, load: () => Promise<T>): Promise<T>;
  delete(key: string): Promise<void>;
}

/** A key part that names an account without carrying its secret: the first bytes of its hash */
export function secretTag(secret: string): string {
  return createHash('sha256').update(secret).digest('hex').slice(0, 16);
}

/** `items` in slices of `size`, in order: one network call each */
export function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
