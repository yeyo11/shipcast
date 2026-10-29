import { ConnectorError, PostGone, type Comment, type CommentReader, type Replier } from '@shipcast/connectors';
import { AI_TASK_DEFINITIONS, channelDefinition, channelName, COMMENT_CHANNELS, ContentPack, InvalidRequest, Refused, REPLY_CAPABILITIES, REPLY_LIMITS, type ArticleSummary, type Brand, type Channel, type CommentChannelId, type ReplyCapability, ReplyAnswer } from '@shipcast/schema';
import { z } from 'zod';
import type { AiTaskRunner } from './ai/runner.ts';
import { isArticle, launchDir } from './drafts.ts';
import type { GitHubSource } from './github.ts';
import { buildReplyPrompt, type PromptOptions, type ReplyPromptInput } from './prompt.ts';
import type { CommentClass, CommentRecord, CommentStatus, Launch, Post, Repositories } from './repositories/index.ts';
import type { CommentStore, SettingReader, SettingStore } from './ports.ts';
import type { CursorRepository } from './repositories/cursors.ts';
import type { Checkout } from './workspace.ts';

/*
 * The comment assistant: it reads the comments under Shipcast's own posts, drafts a reply to each
 * with the AI (grounded in the repo and the launch's analysis, under locked rules), and sends it
 * when the owner approves, or at once on a channel set to auto. See docs/decisions/comment-assistant.md
 */

/** The channels whose comments can be read, from the channel definitions; Telegram, Discord and LinkedIn cannot read replies here */
export { COMMENT_CHANNELS };
export type CommentChannel = CommentChannelId;

export function isCommentChannel(channel: string): channel is CommentChannel {
  return (COMMENT_CHANNELS as readonly string[]).includes(channel);
}

/** `off`: not read; `approval`: drafts wait for the owner's click; `auto`: a draft is sent at once */
export type ReplyMode = 'off' | 'approval' | 'auto';
export const REPLY_MODES: readonly ReplyMode[] = ['off', 'approval', 'auto'];

/** What each channel can do with comments, and how long a reply may be: the maps the app and the API read */
export { REPLY_CAPABILITIES, REPLY_LIMITS, type ReplyCapability };

const NAMES = (channel: CommentChannel) => channelName(channel);

export const COMMENTS_SETTINGS_KEY = 'comments';

export interface CommentSettings {
  replies: Record<CommentChannel, ReplyMode>;
}

/** Approval everywhere: nothing goes out in the owner's name without their click until they choose otherwise */
export const DEFAULT_COMMENT_SETTINGS: CommentSettings = {
  replies: Object.fromEntries(COMMENT_CHANNELS.map((c) => [c, 'approval'])) as Record<CommentChannel, ReplyMode>,
};

export class InvalidCommentSettings extends InvalidRequest {}

/** dev.to cannot send, so auto there means approval: the draft waits to be copied */
function modeFor(channel: CommentChannel, mode: ReplyMode): ReplyMode {
  return mode === 'auto' && !REPLY_CAPABILITIES[channel]?.reply ? 'approval' : mode;
}

export async function readCommentSettings(registry: SettingReader): Promise<CommentSettings> {
  const stored = await registry.settings.setting<{ replies?: Record<string, unknown> }>(COMMENTS_SETTINGS_KEY);
  const replies = { ...DEFAULT_COMMENT_SETTINGS.replies };
  for (const channel of COMMENT_CHANNELS) {
    const value = stored?.replies?.[channel];
    if (typeof value === 'string' && (REPLY_MODES as readonly string[]).includes(value)) replies[channel] = modeFor(channel, value as ReplyMode);
  }
  return { replies };
}

/** Saves the modes given; a channel left out keeps its mode */
export async function writeCommentSettings(registry: SettingStore, input: unknown): Promise<CommentSettings> {
  const replies = (input && typeof input === 'object' ? (input as { replies?: unknown }).replies : undefined) as Record<string, unknown> | undefined;
  if (!replies || typeof replies !== 'object') throw new InvalidCommentSettings('send { replies: { <channel>: off | approval | auto } }');
  const current = await readCommentSettings(registry);
  for (const [channel, mode] of Object.entries(replies)) {
    if (!isCommentChannel(channel)) throw new InvalidCommentSettings(`${channel} has no comments to read (${COMMENT_CHANNELS.join(', ')})`);
    if (typeof mode !== 'string' || !(REPLY_MODES as readonly string[]).includes(mode)) throw new InvalidCommentSettings(`${channel}: the mode is one of ${REPLY_MODES.join(', ')}`);
    current.replies[channel] = modeFor(channel, mode as ReplyMode);
  }
  await registry.settings.setSetting(COMMENTS_SETTINGS_KEY, current);
  return current;
}

/** Why a draft, an edit, a send or a dismissal was not done, so the API can answer 404, 409 or 400 */
export type CommentRefusal = 'not_found' | 'unsupported' | 'invalid' | 'state' | 'no_credentials';

export class CommentRefused extends Refused<CommentRefusal> {}

/** A post a comment feed is asked about: the registry's id and the network's */
export interface FeedPost {
  postId: number;
  externalId: string;
}

/** What a feed says moved since its cursor */
export interface FeedChanges {
  /** Where the next run starts; undefined keeps the one it had */
  cursor: string | undefined;
  /** The posts (network ids) with comments the cursor has not seen: each is read whole */
  touched: ReadonlySet<string>;
  /** Posts whose whole thread the feed read itself (GitHub's nodes(ids:)), needing no read of their own */
  comments?: ReadonlyMap<string, Comment[]>;
}

/**
 * The CommentFeed capability (docs/plans/performance-refactor.md, "One definition per channel"):
 * one call per account says which of its posts have new comments, from the network's notifications
 * since a cursor or a listing of its posts' comment counts, so only those are read. Without a cursor
 * (the first run) every post is touched.
 */
export interface CommentFeed {
  changes(
    posts: readonly FeedPost[],
    cursor: string | undefined,
    known: {
      /** The post (its network id) a comment already recorded is under: how a reply to a reply is placed */
      postOfComment(commentExternalId: string): Promise<string | undefined>;
    },
  ): Promise<FeedChanges>;
}

/** A channel's comment connectors, built with the account the post went out with */
export interface CommentConnectors {
  reader?: CommentReader;
  replier?: Replier;
  /** Where the network has a feed of what is new (the `batched-metrics` flag reads it first) */
  feed?: CommentFeed;
}

export interface CommentDeps {
  registry: Pick<Repositories, 'launches' | 'posts' | 'comments' | 'settings'>;
  /** The connectors of a channel for the account a post went out with (null: the `.env` credentials) */
  connectors(channel: Channel, accountId: number | null): Promise<CommentConnectors>;
  now?: () => Date;
}

export interface FetchResult {
  /** The posts whose comments were read */
  posts: number;
  /** Every comment the networks returned, known ones included */
  found: number;
  /** The comments by others seen for the first time */
  added: CommentRecord[];
  /** Comments the owner had answered on the network themselves, marked sent */
  answeredByHand: number;
  /** Posts the network says no longer exist, marked deleted so no run reads them again */
  gone: Post[];
  problems: string[];
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The states a comment can still be drafted, edited or dismissed from */
const OPEN: readonly CommentStatus[] = ['new', 'draft-ready', 'failed', 'dismissed'];

/**
 * Reads the comments under every live post of the last `days` days on the channels not set to off,
 * and records the ones not known yet. Idempotent: a comment is one row per channel and network id,
 * so a second run adds nothing it already has. A reply the owner wrote on the network marks the
 * comment it answers as sent, so the assistant never drafts what is answered already.
 */
export async function fetchComments(deps: CommentDeps, options: { days?: number } = {}): Promise<FetchResult> {
  const { registry } = deps;
  const now = deps.now?.() ?? new Date();
  const settings = await readCommentSettings(registry);
  const channels = COMMENT_CHANNELS.filter((c) => settings.replies[c] !== 'off');
  const since = new Date(now.getTime() - (options.days ?? 30) * 86_400_000).toISOString();
  const posts = await registry.posts.postsSince(since, channels);
  const problems = new Set<string>();
  const added: CommentRecord[] = [];
  let found = 0;
  let read = 0;
  let answeredByHand = 0;
  const gone: Post[] = [];

  for (const post of posts) {
    if (!post.externalId || !isCommentChannel(post.channel)) continue;
    const name = NAMES(post.channel);
    let list: Comment[];
    try {
      const { reader } = await deps.connectors(post.channel, post.accountId);
      if (!reader) {
        problems.add(`${name}: no connected account to read comments with`);
        continue;
      }
      list = await reader.comments(post.externalId);
    } catch (error) {
      if (error instanceof PostGone) {
        gone.push(await registry.posts.updatePost(post.id, { status: 'deleted' }));
        continue;
      }
      problems.add(`${name} post ${post.id}: ${message(error)}`);
      continue;
    }
    read++;
    found += list.length;
    const recorded = await recordThread(registry, post, list);
    added.push(...recorded.added);
    answeredByHand += recorded.answeredByHand;
  }
  return { posts: read, found, added, answeredByHand, gone, problems: [...problems] };
}

/**
 * Records one post's comments as the network listed them: the new ones by others are returned, and
 * a reply the owner wrote on the network marks the comment it answers as sent.
 */
async function recordThread(registry: CommentDeps['registry'], post: Post, list: readonly Comment[]): Promise<{ added: CommentRecord[]; answeredByHand: number }> {
  const added: CommentRecord[] = [];
  let answeredByHand = 0;
  for (const c of list) {
    const { recorded, comment } = await registry.comments.recordComment({
      postId: post.id,
      channel: post.channel,
      externalId: c.externalId,
      author: c.author,
      text: c.text,
      ...(c.url && { url: c.url }),
      createdAt: c.createdAt,
      ...(c.inReplyTo && { inReplyTo: c.inReplyTo }),
      own: c.own,
      // The owner's own words are kept for the thread's context, never answered
      status: c.own ? 'dismissed' : 'new',
    });
    if (recorded && !comment.own) added.push(comment);
  }
  for (const c of list) {
    if (!c.own || !c.inReplyTo) continue;
    const parent = await registry.comments.commentByExternalId(post.channel, c.inReplyTo);
    if (!parent || parent.own || parent.sentExternalId === c.externalId) continue;
    const marked = await registry.comments.updateComment(
      parent.id,
      { status: 'sent', sentExternalId: c.externalId, sentUrl: c.url ?? null, sentAt: c.createdAt, note: 'Answered on the network', problem: null },
      ['new', 'draft-ready', 'failed'],
    );
    if (marked) answeredByHand++;
  }
  return { added, answeredByHand };
}

/** Where an account's comment feed resumes */
export const commentFeedKey = (channel: string, accountId: number | null) => `comments-feed:${channel}:${accountId ?? 'env'}`;
/** When an account's posts were last all read whole */
export const commentSweepKey = (channel: string, accountId: number | null) => `comments-sweep:${channel}:${accountId ?? 'env'}`;
/**
 * Once a day every post is read whole even where a feed says nothing moved: a feed does not see the
 * owner's own replies (no network notifies its author of them), which is what marks a comment
 * answered by hand, nor a reply deep in an old thread on the feeds that only date their threads.
 */
export const COMMENT_SWEEP_HOURS = 24;

/**
 * The comment run of the `batched-metrics` flag: the same posts as `fetchComments`, one connector
 * per account, each account's feed asked once and only the posts it names read; a network with no
 * feed (Threads) is read post by post, as before. The cursors are kept per account.
 */
export async function fetchCommentsByFeed(deps: CommentDeps, cursors: Pick<CursorRepository, 'cursor' | 'setCursor'>, options: { days?: number } = {}): Promise<FetchResult> {
  const { registry } = deps;
  const now = deps.now?.() ?? new Date();
  const settings = await readCommentSettings(registry);
  const channels = COMMENT_CHANNELS.filter((c) => settings.replies[c] !== 'off');
  const since = new Date(now.getTime() - (options.days ?? 30) * 86_400_000).toISOString();
  const posts = (await registry.posts.postsSince(since, channels)).filter((p): p is Post & { externalId: string; channel: CommentChannel } => p.externalId !== null && isCommentChannel(p.channel));
  const problems = new Set<string>();
  const added: CommentRecord[] = [];
  const gone: Post[] = [];
  let found = 0;
  let read = 0;
  let answeredByHand = 0;

  const accounts = new Map<string, typeof posts>();
  for (const post of posts) {
    const key = `${post.channel}|${post.accountId ?? 'env'}`;
    accounts.set(key, [...(accounts.get(key) ?? []), post]);
  }
  for (const group of accounts.values()) {
    const { channel, accountId } = group[0]!;
    const name = NAMES(channel);
    let connectors: CommentConnectors;
    try {
      connectors = await deps.connectors(channel, accountId);
    } catch (error) {
      problems.add(`${name}: ${message(error)}`);
      continue;
    }
    const { reader, feed } = connectors;
    if (!reader) {
      problems.add(`${name}: no connected account to read comments with`);
      continue;
    }
    const sweepAt = await cursors.cursor(commentSweepKey(channel, accountId));
    const sweep = !feed || !sweepAt || now.getTime() - Date.parse(sweepAt) >= COMMENT_SWEEP_HOURS * 3_600_000 - 10 * 60_000;
    let changes: FeedChanges | undefined;
    if (feed) {
      try {
        const postOf = new Map(group.map((p) => [p.id, p.externalId]));
        changes = await feed.changes(
          group.map((p) => ({ postId: p.id, externalId: p.externalId })),
          await cursors.cursor(commentFeedKey(channel, accountId)),
          { postOfComment: async (id) => postOf.get((await registry.comments.commentByExternalId(channel, id))?.postId ?? -1) },
        );
      } catch (error) {
        // A feed that fails is said; the posts wait for the next run rather than all being read now
        problems.add(`${name} feed: ${message(error)}`);
        continue;
      }
    }
    let failed = false;
    for (const post of group) {
      let list = changes?.comments?.get(post.externalId);
      if (!list) {
        if (!sweep && !changes?.touched.has(post.externalId)) continue;
        try {
          list = await reader.comments(post.externalId);
        } catch (error) {
          if (error instanceof PostGone) {
            gone.push(await registry.posts.updatePost(post.id, { status: 'deleted' }));
            continue;
          }
          problems.add(`${name} post ${post.id}: ${message(error)}`);
          failed = true;
          continue;
        }
      }
      read++;
      found += list.length;
      const recorded = await recordThread(registry, post, list);
      added.push(...recorded.added);
      answeredByHand += recorded.answeredByHand;
    }
    // A post that could not be read keeps the cursor where it was, so the next run asks again
    if (failed) continue;
    if (changes?.cursor !== undefined) await cursors.setCursor(commentFeedKey(channel, accountId), changes.cursor);
    if (sweep && feed) await cursors.setCursor(commentSweepKey(channel, accountId), now.toISOString());
  }
  return { posts: read, found, added, answeredByHand, gone, problems: [...problems] };
}

/** What a reply is grounded in, per launch: its analysis, the post as published, and the code */
export interface ReplyContext {
  analysis?: ReplyPromptInput['analysis'];
  /** Each channel's text as the pack had it */
  postText: Partial<Record<CommentChannel, string>>;
  /** The checkout on this machine, when there is one */
  hostDir?: string;
  /** The released code's repo and ref, when there is code: what a remote agent's workspace is made from */
  repo?: { name: string; ref: string };
}

export interface ReplyDeps extends CommentDeps {
  brand: Brand;
  /** The AI task runner the replies are drafted on */
  aiRunner: AiTaskRunner;
  /** The owner's prompts and tone, read before each reply; the defaults in code without */
  texts?(): Promise<PromptOptions>;
  /** A launch's grounding; called once per launch per run */
  context(launch: Launch): Promise<ReplyContext>;
}

// Moved to packages/schema/src/ai/answers.ts with the AI task definitions; kept here for its callers
export { ReplyAnswer, replyJsonSchema } from '@shipcast/schema';

/** A reply's length as the network counts it: graphemes on Bluesky, emoji bytes on Threads, characters elsewhere */
export function replyLength(channel: CommentChannel, text: string): number {
  const count = channelDefinition(channel).comments?.replyLength;
  return count ? count(text) : [...text].length;
}

function tooLong(channel: CommentChannel, text: string): string | undefined {
  const length = replyLength(channel, text);
  const limit = REPLY_LIMITS[channel];
  return length > limit ? `the reply has ${length} characters; ${NAMES(channel)} replies here are at most ${limit}` : undefined;
}

/** The comments above one in its thread, oldest first, at most a few levels up */
async function threadOf(registry: CommentStore, comment: CommentRecord): Promise<CommentRecord[]> {
  const chain: CommentRecord[] = [];
  let parentId = comment.inReplyTo;
  while (parentId && chain.length < 6) {
    const parent = await registry.comments.commentByExternalId(comment.channel, parentId);
    if (!parent) break;
    chain.unshift(parent);
    parentId = parent.inReplyTo;
  }
  return chain;
}

async function existing(registry: CommentStore, id: number): Promise<CommentRecord & { channel: CommentChannel }> {
  const comment = await registry.comments.comment(id);
  if (!comment) throw new CommentRefused('not_found', 'no such comment');
  if (!isCommentChannel(comment.channel)) throw new CommentRefused('unsupported', `${comment.channel} has no comment assistant`);
  return comment as CommentRecord & { channel: CommentChannel };
}

/**
 * Drafts the reply to one comment, or classifies it as one to dismiss. A comment being sent or sent
 * already is refused; one dismissed by the owner can be drafted again. Fails into the comment's own
 * `failed` state with the reason, never silently. `contexts` caches the grounding per launch.
 */
export async function draftReply(id: number, deps: ReplyDeps, contexts = new Map<number, Promise<ReplyContext>>()): Promise<CommentRecord> {
  const { registry } = deps;
  const comment = await existing(registry, id);
  if (comment.own) throw new CommentRefused('unsupported', 'this is your own comment');
  if (!OPEN.includes(comment.status)) throw new CommentRefused('state', `the comment is ${comment.status}: nothing to draft`);
  const fail = async (problem: string) => (await registry.comments.updateComment(id, { status: 'failed', problem }, OPEN)) ?? comment;
  try {
    const post = (await registry.posts.post(comment.postId))!;
    const launch = (await registry.launches.get(comment.launchId))!;
    if (!contexts.has(launch.id)) contexts.set(launch.id, deps.context(launch));
    const context = await contexts.get(launch.id)!;
    const texts: PromptOptions = (await deps.texts?.()) ?? {};
    const thread = await threadOf(registry, comment);
    const { prompt, system } = buildReplyPrompt(
      {
        network: NAMES(comment.channel),
        limit: REPLY_LIMITS[comment.channel],
        comment: { author: comment.author.handle, text: comment.text },
        thread: thread.map((t) => ({ author: t.author.handle, text: t.text, own: t.own })),
        post: { text: context.postText[comment.channel], url: post.url },
        launch: { repo: launch.repo, ref: launch.ref, article: isArticle(launch) },
        ...(context.analysis && { analysis: context.analysis }),
        hasCode: context.hostDir !== undefined,
      },
      deps.brand,
      texts,
    );
    // The code is read by the provider's own means: the clone's tools, or a remote workspace of the release
    const repo = context.repo && { ...context.repo, ...(context.hostDir && { hostDir: context.hostDir }) };
    const { output } = await deps.aiRunner.run(AI_TASK_DEFINITIONS.replies, { system, prompt, ...(repo && { repo }) });
    const parsed = ReplyAnswer.safeParse(output);
    if (!parsed.success) return fail(`the AI's answer is not a reply: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    const answer = parsed.data;
    const classification: CommentClass = answer.classification;
    const reply = answer.reply.trim();
    // Spam and abuse are never answered, whatever else the model wrote
    if (answer.dismiss || classification === 'spam' || classification === 'abuse' || !reply) {
      return (await registry.comments.updateComment(id, { status: 'draft-ready', classification, draft: null, note: answer.reason || 'Suggested: dismiss', problem: null }, OPEN)) ?? comment;
    }
    return (await registry.comments.updateComment(id, { status: 'draft-ready', classification, draft: reply, note: answer.reason || null, problem: tooLong(comment.channel, reply) ?? null }, OPEN)) ?? comment;
  } catch (error) {
    if (error instanceof CommentRefused) throw error;
    return fail(`could not draft: ${message(error)}`);
  }
}

/** The owner's own words for a reply, replacing the draft */
export async function editReplyDraft(id: number, text: string, registry: CommentStore): Promise<CommentRecord> {
  const comment = await existing(registry, id);
  if (comment.own) throw new CommentRefused('unsupported', 'this is your own comment');
  const draft = text.trim();
  if (!draft) throw new CommentRefused('invalid', 'a reply cannot be empty; dismiss the comment instead');
  const long = tooLong(comment.channel, draft);
  if (long) throw new CommentRefused('invalid', long);
  const updated = await registry.comments.updateComment(id, { status: 'draft-ready', draft, problem: null }, OPEN);
  if (!updated) throw new CommentRefused('state', `the comment is ${(await registry.comments.comment(id))?.status ?? 'gone'}: its reply cannot change`);
  return updated;
}

export async function dismissComment(id: number, registry: CommentStore): Promise<CommentRecord> {
  await existing(registry, id);
  const updated = await registry.comments.updateComment(id, { status: 'dismissed' }, ['new', 'draft-ready', 'failed']);
  if (!updated) throw new CommentRefused('state', `the comment is ${(await registry.comments.comment(id))?.status ?? 'gone'}: it cannot be dismissed`);
  return updated;
}

/** The key that makes a second send of one reply a no-op where the network takes one */
export const replyKey = (comment: Pick<CommentRecord, 'channel' | 'externalId'>) => `shipcast-reply-${comment.channel}-${comment.externalId}`.slice(0, 200);

/**
 * Sends a comment's draft, with the account its post went out with. The comment is claimed first
 * (draft-ready or failed to approved, in one update), so a second click or a second worker finds it
 * claimed and sends nothing; it ends sent, or failed with the network's words.
 */
export async function sendReply(id: number, deps: CommentDeps): Promise<CommentRecord> {
  const { registry } = deps;
  const comment = await existing(registry, id);
  if (comment.own) throw new CommentRefused('unsupported', 'this is your own comment');
  const capability = REPLY_CAPABILITIES[comment.channel]!;
  if (!capability.reply) throw new CommentRefused('unsupported', `${NAMES(comment.channel)} cannot reply through its API: ${capability.note}`);
  if (!comment.draft) throw new CommentRefused('invalid', 'there is no reply to send: draft or write one first');
  const long = tooLong(comment.channel, comment.draft);
  if (long) throw new CommentRefused('invalid', long);
  const post = (await registry.posts.post(comment.postId)) as Post;
  if (!post.externalId) throw new CommentRefused('unsupported', 'the post has no id on the network to reply under');

  const { replier } = await deps.connectors(comment.channel, post.accountId).catch((error: unknown) => {
    throw new CommentRefused('no_credentials', message(error));
  });
  if (!replier) throw new CommentRefused('no_credentials', `no ${NAMES(comment.channel)} account to reply with: the one the post went out with is not connected`);
  const claimed = await registry.comments.updateComment(id, { status: 'approved', problem: null }, ['draft-ready', 'failed']);
  if (!claimed) throw new CommentRefused('state', `the comment is ${(await registry.comments.comment(id))?.status ?? 'gone'}: it is not waiting to be sent`);
  try {
    const sent = await replier.reply({ postExternalId: post.externalId, commentExternalId: comment.externalId, authorHandle: comment.author.handle }, comment.draft, { key: replyKey(comment) });
    const now = (deps.now?.() ?? new Date()).toISOString();
    return (await registry.comments.updateComment(id, { status: 'sent', sentExternalId: sent.externalId, sentUrl: sent.url ?? post.url, sentAt: now }))!;
  } catch (error) {
    await registry.comments.updateComment(id, { status: 'failed', problem: message(error) });
    throw error instanceof ConnectorError ? error : new ConnectorError(NAMES(comment.channel), message(error));
  }
}

export interface CommentRunResult extends FetchResult {
  drafted: CommentRecord[];
  sent: CommentRecord[];
  /** Comments the AI suggests dismissing */
  toDismiss: number;
}

/** Drafts per run at most: each is an AI call, and a sudden flood of comments must not become a bill */
export const MAX_DRAFTS_PER_RUN = 20;

/**
 * One run of the assistant: read the comments, draft a reply to every new one on a channel not off,
 * then send the drafts of the channels set to auto (never a comment to dismiss, never a draft over
 * the limit). A draft or a send that fails is recorded on its comment and the run goes on.
 */
export async function runComments(
  deps: ReplyDeps,
  options: { days?: number; log?: (line: string) => void; feeds?: { cursors: Pick<CursorRepository, 'cursor' | 'setCursor'> } } = {},
): Promise<CommentRunResult> {
  const log = options.log ?? (() => {});
  const fetched = options.feeds ? await fetchCommentsByFeed(deps, options.feeds.cursors, options) : await fetchComments(deps, options);
  log(`Read ${fetched.posts} posts: ${fetched.found} comments, ${fetched.added.length} new${fetched.answeredByHand ? `, ${fetched.answeredByHand} already answered by you` : ''}`);
  for (const post of fetched.gone) log(`${isCommentChannel(post.channel) ? NAMES(post.channel) : post.channel} post ${post.id} no longer exists on the network: marked deleted, and not read again`);
  for (const problem of fetched.problems) log(problem);
  const settings = await readCommentSettings(deps.registry);
  const waiting = (await deps.registry.comments.comments({ status: 'new', own: false, limit: 500 })).filter((c) => isCommentChannel(c.channel) && settings.replies[c.channel] !== 'off');
  const drafted: CommentRecord[] = [];
  const sent: CommentRecord[] = [];
  let toDismiss = 0;
  const contexts = new Map<number, Promise<ReplyContext>>();
  for (const comment of waiting.slice(0, MAX_DRAFTS_PER_RUN)) {
    const result = await draftReply(comment.id, deps, contexts);
    if (result.status === 'failed') {
      log(`Comment ${comment.id}: ${result.problem ?? 'could not draft'}`);
      continue;
    }
    drafted.push(result);
    if (!result.draft) {
      toDismiss++;
      continue;
    }
    if (isCommentChannel(result.channel) && settings.replies[result.channel] === 'auto' && !result.problem) {
      try {
        sent.push(await sendReply(result.id, deps));
      } catch (error) {
        log(`Comment ${comment.id}: could not send: ${message(error)}`);
      }
    }
  }
  if (waiting.length > MAX_DRAFTS_PER_RUN) log(`${waiting.length - MAX_DRAFTS_PER_RUN} comments wait for the next run`);
  return { ...fetched, drafted, sent, toDismiss };
}

/**
 * What a reply is grounded in, read for one launch: the analysis and each channel's text from the
 * pack the launches repo holds, and a fresh checkout of the released code for the AI to read. An
 * article has no code: the article is the truth, and its pack's summary says what it is.
 */
export function launchReplyContext(deps: {
  github: Pick<GitHubSource, 'fileAt'>;
  launchesRepo: string;
  checkout: (repo: string, ref: string) => Promise<Checkout>;
}): (launch: Launch) => Promise<ReplyContext> {
  return async (launch) => {
    const text = await deps.github.fileAt(deps.launchesRepo, `${launchDir(launch)}/pack.json`, 'HEAD').catch(() => undefined);
    let pack: ContentPack | undefined;
    try {
      const parsed = text === undefined ? undefined : ContentPack.safeParse(JSON.parse(text));
      pack = parsed?.success ? parsed.data : undefined;
    } catch {
      // A pack that is not JSON grounds nothing; the reply is drafted from the post and the code
    }
    const postText: ReplyContext['postText'] = {};
    const english = pack?.article?.en ?? pack?.article?.es;
    // What each post said, as its channel's definition reads it from its piece (dev.to's is the article)
    for (const channel of COMMENT_CHANNELS) {
      const definition = channelDefinition(channel);
      const piece = pack?.[definition.pack.key as keyof ContentPack];
      const read = definition.pack.postText as ((piece: unknown, article: ArticleSummary | undefined) => string | undefined) | undefined;
      // No piece, no post of that channel to have been commented on
      const text = read && piece !== undefined ? read(piece, english) : undefined;
      if (text) postText[channel] = text;
    }
    const base = { ...(pack && { analysis: pack.analysis }), postText };
    if (isArticle(launch)) return base;
    const ref = launch.ref.startsWith('public:') ? 'HEAD' : launch.ref;
    const checkout = await deps.checkout(launch.repo, ref);
    return { ...base, hostDir: checkout.hostPath, repo: { name: launch.repo, ref } };
  };
}
