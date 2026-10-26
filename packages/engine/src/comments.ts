import { ConnectorError, type Comment, type CommentReader, type Replier } from '@shipcast/connectors';
import { ContentPack, graphemeCount, threadsLength, type Brand, type Channel } from '@shipcast/schema';
import { z } from 'zod';
import type { AiSetup } from './ai.ts';
import { isArticle, launchDir } from './drafts.ts';
import type { GitHubSource } from './github.ts';
import { ANALYSIS_TOOLS, buildReplyPrompt, type ReplyPromptInput } from './prompt.ts';
import type { CommentClass, CommentRecord, CommentStatus, Launch, Post, Registry } from './registry.ts';
import type { Checkout } from './workspace.ts';

/*
 * The comment assistant: it reads the comments under Shipcast's own posts, drafts a reply to each
 * with the AI (grounded in the repo and the launch's analysis, under locked rules), and sends it
 * when the owner approves, or at once on a channel set to auto. See docs/decisions/comment-assistant.md
 */

/** The channels whose comments can be read; Telegram, Discord and LinkedIn cannot read replies here */
export const COMMENT_CHANNELS = ['mastodon', 'bluesky', 'instagram', 'devto', 'threads', 'githubDiscussions'] as const satisfies readonly Channel[];
export type CommentChannel = (typeof COMMENT_CHANNELS)[number];

export function isCommentChannel(channel: string): channel is CommentChannel {
  return (COMMENT_CHANNELS as readonly string[]).includes(channel);
}

/** `off`: not read; `approval`: drafts wait for the owner's click; `auto`: a draft is sent at once */
export type ReplyMode = 'off' | 'approval' | 'auto';
export const REPLY_MODES: readonly ReplyMode[] = ['off', 'approval', 'auto'];

export interface ReplyCapability {
  read: boolean;
  reply: boolean;
  note: string;
}

/** What each channel can do with comments: the map the app and the API read */
export const REPLY_CAPABILITIES: Readonly<Record<string, ReplyCapability>> = {
  mastodon: { read: true, reply: true, note: 'The public and unlisted replies under the status; a reply mentions the author so they are notified' },
  bluesky: { read: true, reply: true, note: 'The replies in the post’s thread, from the public AppView; a reply is threaded under the comment' },
  instagram: { read: true, reply: true, note: 'Needs the instagram_business_manage_comments permission on the connected account' },
  devto: { read: true, reply: false, note: 'Forem’s API reads comments but cannot write one: the draft is copied and posted on dev.to' },
  telegram: { read: false, reply: false, note: 'A bot cannot read the replies to a channel post' },
  discord: { read: false, reply: false, note: 'A webhook cannot read the replies to its message' },
  threads: { read: true, reply: true, note: 'Every reply in the post’s conversation (threads_read_replies); a reply is a post under the comment (threads_manage_replies)' },
  githubDiscussions: { read: true, reply: true, note: 'The comments and their replies, through the GitHub App; a reply is written by the App’s bot, not by your own GitHub account' },
  linkedin: { read: false, reply: false, note: 'Reading comments on a member’s post needs LinkedIn’s Community Management API, granted only to approved companies' },
};

/** How long a reply may be on each network: short on purpose, under what the network itself allows */
export const REPLY_LIMITS: Readonly<Record<CommentChannel, number>> = {
  // Mastodon counts the mention added in front of the text, so the draft leaves room for it
  mastodon: 400,
  bluesky: 300,
  instagram: 300,
  devto: 600,
  threads: 400,
  githubDiscussions: 1000,
};

const NAMES: Record<CommentChannel, string> = {
  mastodon: 'Mastodon',
  bluesky: 'Bluesky',
  instagram: 'Instagram',
  devto: 'dev.to',
  threads: 'Threads',
  githubDiscussions: 'GitHub Discussions',
};

export const COMMENTS_SETTINGS_KEY = 'comments';

export interface CommentSettings {
  replies: Record<CommentChannel, ReplyMode>;
}

/** Approval everywhere: nothing goes out in the owner's name without their click until they choose otherwise */
export const DEFAULT_COMMENT_SETTINGS: CommentSettings = {
  replies: { mastodon: 'approval', bluesky: 'approval', instagram: 'approval', devto: 'approval', threads: 'approval', githubDiscussions: 'approval' },
};

export class InvalidCommentSettings extends Error {}

/** dev.to cannot send, so auto there means approval: the draft waits to be copied */
function modeFor(channel: CommentChannel, mode: ReplyMode): ReplyMode {
  return mode === 'auto' && !REPLY_CAPABILITIES[channel]?.reply ? 'approval' : mode;
}

export async function readCommentSettings(registry: Registry): Promise<CommentSettings> {
  const stored = await registry.setting<{ replies?: Record<string, unknown> }>(COMMENTS_SETTINGS_KEY);
  const replies = { ...DEFAULT_COMMENT_SETTINGS.replies };
  for (const channel of COMMENT_CHANNELS) {
    const value = stored?.replies?.[channel];
    if (typeof value === 'string' && (REPLY_MODES as readonly string[]).includes(value)) replies[channel] = modeFor(channel, value as ReplyMode);
  }
  return { replies };
}

/** Saves the modes given; a channel left out keeps its mode */
export async function writeCommentSettings(registry: Registry, input: unknown): Promise<CommentSettings> {
  const replies = (input && typeof input === 'object' ? (input as { replies?: unknown }).replies : undefined) as Record<string, unknown> | undefined;
  if (!replies || typeof replies !== 'object') throw new InvalidCommentSettings('send { replies: { <channel>: off | approval | auto } }');
  const current = await readCommentSettings(registry);
  for (const [channel, mode] of Object.entries(replies)) {
    if (!isCommentChannel(channel)) throw new InvalidCommentSettings(`${channel} has no comments to read (${COMMENT_CHANNELS.join(', ')})`);
    if (typeof mode !== 'string' || !(REPLY_MODES as readonly string[]).includes(mode)) throw new InvalidCommentSettings(`${channel}: the mode is one of ${REPLY_MODES.join(', ')}`);
    current.replies[channel] = modeFor(channel, mode as ReplyMode);
  }
  await registry.setSetting(COMMENTS_SETTINGS_KEY, current);
  return current;
}

/** Why a draft, an edit, a send or a dismissal was not done, so the API can answer 404, 409 or 400 */
export type CommentRefusal = 'not_found' | 'unsupported' | 'invalid' | 'state' | 'no_credentials';

export class CommentRefused extends Error {
  readonly reason: CommentRefusal;

  constructor(reason: CommentRefusal, message: string) {
    super(message);
    this.reason = reason;
  }
}

/** A channel's comment connectors, built with the account the post went out with */
export interface CommentConnectors {
  reader?: CommentReader;
  replier?: Replier;
}

export interface CommentDeps {
  registry: Registry;
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
  const posts = await registry.postsSince(since, channels);
  const problems = new Set<string>();
  const added: CommentRecord[] = [];
  let found = 0;
  let read = 0;
  let answeredByHand = 0;

  for (const post of posts) {
    if (!post.externalId || !isCommentChannel(post.channel)) continue;
    const name = NAMES[post.channel];
    let list: Comment[];
    try {
      const { reader } = await deps.connectors(post.channel, post.accountId);
      if (!reader) {
        problems.add(`${name}: no connected account to read comments with`);
        continue;
      }
      list = await reader.comments(post.externalId);
    } catch (error) {
      problems.add(`${name} post ${post.id}: ${message(error)}`);
      continue;
    }
    read++;
    found += list.length;
    for (const c of list) {
      const { recorded, comment } = await registry.recordComment({
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
      const parent = await registry.commentByExternalId(post.channel, c.inReplyTo);
      if (!parent || parent.own || parent.sentExternalId === c.externalId) continue;
      const marked = await registry.updateComment(
        parent.id,
        { status: 'sent', sentExternalId: c.externalId, sentUrl: c.url ?? null, sentAt: c.createdAt, note: 'Answered on the network', problem: null },
        ['new', 'draft-ready', 'failed'],
      );
      if (marked) answeredByHand++;
    }
  }
  return { posts: read, found, added, answeredByHand, problems: [...problems] };
}

/** What a reply is grounded in, per launch: its analysis, the post as published, and the code */
export interface ReplyContext {
  analysis?: ReplyPromptInput['analysis'];
  /** Each channel's text as the pack had it */
  postText: Partial<Record<CommentChannel, string>>;
  /** Where the AI works: the checkout as the provider sees it, or a folder with no repo */
  cwd: string;
  /** The checkout on this machine, when there is one */
  hostDir?: string;
}

export interface ReplyDeps extends CommentDeps {
  brand: Brand;
  /** The `replies` task's provider, model, prompts and tone, read from the AI settings */
  setup(): Promise<AiSetup>;
  /** A launch's grounding; called once per launch per run */
  context(launch: Launch): Promise<ReplyContext>;
}

/** The answer the AI gives for one comment: the contract, whatever the provider */
export const ReplyAnswer = z.object({
  classification: z.enum(['question', 'feedback', 'praise', 'bug', 'spam', 'abuse', 'other']),
  language: z.string().max(10),
  dismiss: z.boolean(),
  reply: z.string().max(5000),
  reason: z.string().max(1000),
});
export type ReplyAnswer = z.infer<typeof ReplyAnswer>;

export function replyJsonSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['classification', 'language', 'dismiss', 'reply', 'reason'],
    properties: {
      classification: { type: 'string', enum: ['question', 'feedback', 'praise', 'bug', 'spam', 'abuse', 'other'], description: 'What the comment is' },
      language: { type: 'string', description: 'The comment’s language, ISO 639-1 (en, es…)' },
      dismiss: { type: 'boolean', description: 'True for spam, abuse or anything that should get no reply' },
      reply: { type: 'string', description: 'The reply, in the comment’s language; empty when dismissed' },
      reason: { type: 'string', description: 'One line for the owner: why this reply, or why to dismiss' },
    },
  };
}

/** A reply's length as the network counts it: graphemes on Bluesky, emoji bytes on Threads, characters elsewhere */
export function replyLength(channel: CommentChannel, text: string): number {
  if (channel === 'threads') return threadsLength(text);
  return channel === 'bluesky' ? graphemeCount(text) : [...text].length;
}

function tooLong(channel: CommentChannel, text: string): string | undefined {
  const length = replyLength(channel, text);
  const limit = REPLY_LIMITS[channel];
  return length > limit ? `the reply has ${length} characters; ${NAMES[channel]} replies here are at most ${limit}` : undefined;
}

/** The comments above one in its thread, oldest first, at most a few levels up */
async function threadOf(registry: Registry, comment: CommentRecord): Promise<CommentRecord[]> {
  const chain: CommentRecord[] = [];
  let parentId = comment.inReplyTo;
  while (parentId && chain.length < 6) {
    const parent = await registry.commentByExternalId(comment.channel, parentId);
    if (!parent) break;
    chain.unshift(parent);
    parentId = parent.inReplyTo;
  }
  return chain;
}

async function existing(registry: Registry, id: number): Promise<CommentRecord & { channel: CommentChannel }> {
  const comment = await registry.comment(id);
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
  const fail = async (problem: string) => (await registry.updateComment(id, { status: 'failed', problem }, OPEN)) ?? comment;
  try {
    const post = (await registry.post(comment.postId))!;
    const launch = (await registry.get(comment.launchId))!;
    if (!contexts.has(launch.id)) contexts.set(launch.id, deps.context(launch));
    const context = await contexts.get(launch.id)!;
    const setup = await deps.setup();
    const thread = await threadOf(registry, comment);
    const { prompt, system } = buildReplyPrompt(
      {
        network: NAMES[comment.channel],
        limit: REPLY_LIMITS[comment.channel],
        comment: { author: comment.author.handle, text: comment.text },
        thread: thread.map((t) => ({ author: t.author.handle, text: t.text, own: t.own })),
        post: { text: context.postText[comment.channel], url: post.url },
        launch: { repo: launch.repo, ref: launch.ref, article: isArticle(launch) },
        ...(context.analysis && { analysis: context.analysis }),
        hasCode: context.hostDir !== undefined,
      },
      deps.brand,
      { prompts: setup.prompts, tone: setup.tone },
    );
    const result = await setup.provider.generateObject({
      prompt,
      appendSystemPrompt: system,
      jsonSchema: replyJsonSchema(),
      cwd: context.cwd,
      ...(context.hostDir && { hostDir: context.hostDir }),
      allowedTools: context.hostDir ? ANALYSIS_TOOLS : [],
      model: setup.model,
      maxTurns: 20,
    });
    const parsed = ReplyAnswer.safeParse(result.output);
    if (!parsed.success) return fail(`the AI's answer is not a reply: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    const answer = parsed.data;
    const classification: CommentClass = answer.classification;
    const reply = answer.reply.trim();
    // Spam and abuse are never answered, whatever else the model wrote
    if (answer.dismiss || classification === 'spam' || classification === 'abuse' || !reply) {
      return (await registry.updateComment(id, { status: 'draft-ready', classification, draft: null, note: answer.reason || 'Suggested: dismiss', problem: null }, OPEN)) ?? comment;
    }
    return (await registry.updateComment(id, { status: 'draft-ready', classification, draft: reply, note: answer.reason || null, problem: tooLong(comment.channel, reply) ?? null }, OPEN)) ?? comment;
  } catch (error) {
    if (error instanceof CommentRefused) throw error;
    return fail(`could not draft: ${message(error)}`);
  }
}

/** The owner's own words for a reply, replacing the draft */
export async function editReplyDraft(id: number, text: string, registry: Registry): Promise<CommentRecord> {
  const comment = await existing(registry, id);
  if (comment.own) throw new CommentRefused('unsupported', 'this is your own comment');
  const draft = text.trim();
  if (!draft) throw new CommentRefused('invalid', 'a reply cannot be empty; dismiss the comment instead');
  const long = tooLong(comment.channel, draft);
  if (long) throw new CommentRefused('invalid', long);
  const updated = await registry.updateComment(id, { status: 'draft-ready', draft, problem: null }, OPEN);
  if (!updated) throw new CommentRefused('state', `the comment is ${(await registry.comment(id))?.status ?? 'gone'}: its reply cannot change`);
  return updated;
}

export async function dismissComment(id: number, registry: Registry): Promise<CommentRecord> {
  await existing(registry, id);
  const updated = await registry.updateComment(id, { status: 'dismissed' }, ['new', 'draft-ready', 'failed']);
  if (!updated) throw new CommentRefused('state', `the comment is ${(await registry.comment(id))?.status ?? 'gone'}: it cannot be dismissed`);
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
  if (!capability.reply) throw new CommentRefused('unsupported', `${NAMES[comment.channel]} cannot reply through its API: ${capability.note}`);
  if (!comment.draft) throw new CommentRefused('invalid', 'there is no reply to send: draft or write one first');
  const long = tooLong(comment.channel, comment.draft);
  if (long) throw new CommentRefused('invalid', long);
  const post = (await registry.post(comment.postId)) as Post;
  if (!post.externalId) throw new CommentRefused('unsupported', 'the post has no id on the network to reply under');

  const { replier } = await deps.connectors(comment.channel, post.accountId).catch((error: unknown) => {
    throw new CommentRefused('no_credentials', message(error));
  });
  if (!replier) throw new CommentRefused('no_credentials', `no ${NAMES[comment.channel]} account to reply with: the one the post went out with is not connected`);
  const claimed = await registry.updateComment(id, { status: 'approved', problem: null }, ['draft-ready', 'failed']);
  if (!claimed) throw new CommentRefused('state', `the comment is ${(await registry.comment(id))?.status ?? 'gone'}: it is not waiting to be sent`);
  try {
    const sent = await replier.reply({ postExternalId: post.externalId, commentExternalId: comment.externalId, authorHandle: comment.author.handle }, comment.draft, { key: replyKey(comment) });
    const now = (deps.now?.() ?? new Date()).toISOString();
    return (await registry.updateComment(id, { status: 'sent', sentExternalId: sent.externalId, sentUrl: sent.url ?? post.url, sentAt: now }))!;
  } catch (error) {
    await registry.updateComment(id, { status: 'failed', problem: message(error) });
    throw error instanceof ConnectorError ? error : new ConnectorError(NAMES[comment.channel], message(error));
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
export async function runComments(deps: ReplyDeps, options: { days?: number; log?: (line: string) => void } = {}): Promise<CommentRunResult> {
  const log = options.log ?? (() => {});
  const fetched = await fetchComments(deps, options);
  log(`Read ${fetched.posts} posts: ${fetched.found} comments, ${fetched.added.length} new${fetched.answeredByHand ? `, ${fetched.answeredByHand} already answered by you` : ''}`);
  for (const problem of fetched.problems) log(problem);
  const settings = await readCommentSettings(deps.registry);
  const waiting = (await deps.registry.comments({ status: 'new', own: false, limit: 500 })).filter((c) => isCommentChannel(c.channel) && settings.replies[c.channel] !== 'off');
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
  /** Where the AI works when there is no repo to check out */
  aiWorkdir?: string;
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
    if (pack?.mastodon) postText.mastodon = pack.mastodon.text;
    if (pack?.bluesky) postText.bluesky = pack.bluesky.text;
    if (pack?.instagram) postText.instagram = pack.instagram.caption;
    const english = pack?.article?.en ?? pack?.article?.es;
    if (english) postText.devto = `${english.title}\n\n${english.description}`;
    const base = { ...(pack && { analysis: pack.analysis }), postText };
    if (isArticle(launch)) return { ...base, cwd: deps.aiWorkdir ?? '/workspace' };
    const checkout = await deps.checkout(launch.repo, launch.ref.startsWith('public:') ? 'HEAD' : launch.ref);
    return { ...base, cwd: checkout.providerPath, hostDir: checkout.hostPath };
  };
}
