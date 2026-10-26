import { ConnectorError } from '@shipcast/connectors';
import {
  cancelScheduledPost,
  deleteLaunchPosts,
  deletePost,
  editPost,
  launchConfigOf,
  PostRefused,
  recommendFor,
  reschedulePost,
  SCHEDULABLE_CHANNELS,
  scheduleLaunch,
  ScheduleRefused,
  type EditDeps,
  type Post,
  type PostChanges,
  type PostOutcome,
  type Registry,
  type ReviewGitHub,
} from '@shipcast/engine';
import type { Channel } from '@shipcast/schema';
import { id, InvalidInput, object, text } from './input.ts';
import type { PieceState } from './pieces.ts';
import { postChanges } from './post-changes.ts';
import { channelName, moment } from './requests.ts';

/*
 * What the launch page does to its published pieces and their times, on the engine's operations
 * (docs/decisions/edit-delete.md, docs/scheduling.md). The checks are the REST API's (post-changes.ts,
 * requests.ts), so the page and the API accept the same things. Every answer is data: ok with the
 * piece as it is now, or the problem in the engine's or the network's words for the page to explain;
 * a page never sees a thrown error. The server functions in posts.functions.ts are thin over these,
 * and the tests run them on PGlite.
 */

export interface PostActionDeps {
  registry: Registry;
  editing(): Promise<EditDeps>;
  /** Queues (or moves) the wake-up of each scheduled piece */
  armSchedule(posts: Post[]): Promise<void>;
  /** For the launch's launch.yml: a channel it sets to off cannot be scheduled */
  github: Pick<ReviewGitHub, 'fileAt'>;
  launchesRepo: string;
}

export type Answer<T> = { ok: true; value: T } | { ok: false; problem: string; reason: string };

const state = (post: Post): PieceState => ({ id: post.id, status: post.status, updatedAt: post.updatedAt, scheduledAt: post.scheduledAt });

/** Runs one action, turning what was refused (by the engine, a network or the input) into the page's problem */
async function answer<T>(work: () => Promise<T>): Promise<Answer<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    if (error instanceof PostRefused || error instanceof ScheduleRefused) return { ok: false, problem: error.message, reason: error.reason };
    if (error instanceof InvalidInput) return { ok: false, problem: error.message, reason: 'invalid' };
    if (error instanceof ConnectorError) return { ok: false, problem: error.message, reason: 'upstream' };
    return { ok: false, problem: error instanceof Error ? error.message : String(error), reason: 'failed' };
  }
}

/* ---------- The requests, checked ---------- */

export function editRequest(input: unknown): { postId: number; changes: PostChanges } {
  const o = object(input, 'input');
  return { postId: id(o.postId, 'postId'), changes: postChanges(o.changes) };
}

export function postRequest(input: unknown): { postId: number } {
  return { postId: id(object(input, 'input').postId, 'postId') };
}

/** Several pieces of one launch, and the shared fields to send them */
export function editManyRequest(input: unknown): { launchId: number; postIds: number[]; changes: PostChanges } {
  const o = object(input, 'input');
  if (!Array.isArray(o.postIds) || o.postIds.length === 0) throw new InvalidInput('choose at least one piece');
  if (o.postIds.length > 50) throw new InvalidInput('at most 50 pieces at once');
  const changes = postChanges(o.changes);
  // Title and tags are an article's own: the same title on a Mastodon post and a dev.to article means nothing
  if (changes.title !== undefined || changes.tags !== undefined) throw new InvalidInput('several pieces at once share the text, the link and the image only');
  return { launchId: id(o.launchId, 'launchId'), postIds: [...new Set(o.postIds.map((v, i) => id(v, `postIds[${i}]`)))], changes };
}

/** Deleting everything a launch published, confirmed by typing the repo's name */
export function deleteAllRequest(input: unknown): { launchId: number; confirm: string } {
  const o = object(input, 'input');
  return { launchId: id(o.launchId, 'launchId'), confirm: text(o.confirm, 'confirm', 200).trim() };
}

export function scheduleRequest(input: unknown): { launchId: number; channel: Channel; at: Date } {
  const o = object(input, 'input');
  const channel = channelName(o.channel);
  if (!SCHEDULABLE_CHANNELS.includes(channel)) throw new InvalidInput(`${channel} has no time: the channels are ${SCHEDULABLE_CHANNELS.join(', ')}`);
  return { launchId: id(o.launchId, 'launchId'), channel, at: moment(o.at, 'at') };
}

export function moveRequest(input: unknown): { postId: number; at: Date } {
  const o = object(input, 'input');
  return { postId: id(o.postId, 'postId'), at: moment(o.at, 'at') };
}

export function recommendRequest(input: unknown): { channel: Channel } {
  const channel = channelName(object(input, 'input').channel);
  if (!SCHEDULABLE_CHANNELS.includes(channel)) throw new InvalidInput(`${channel} is not published by Shipcast, so it has no times`);
  return { channel };
}

/** Checks a request inside the answer, so a bad one comes back as a problem rather than a thrown error */
const checked = <R, T>(parse: () => R, run: (request: R) => Promise<T>) => answer(async () => run(parse()));

/* ---------- The actions ---------- */

export function editOne(deps: PostActionDeps, input: unknown): Promise<Answer<PieceState>> {
  return checked(
    () => editRequest(input),
    async ({ postId, changes }) => state(await editPost(postId, changes, await deps.editing())),
  );
}

export function deleteOne(deps: PostActionDeps, input: unknown): Promise<Answer<PieceState>> {
  return checked(
    () => postRequest(input),
    async ({ postId }) => state(await deletePost(postId, await deps.editing())),
  );
}

export type PieceOutcome = { postId: number; channel: string; kind: string } & ({ ok: true; piece: PieceState } | { ok: false; reason: string; problem: string });

const outcome = (o: PostOutcome): PieceOutcome =>
  o.ok ? { postId: o.postId, channel: o.channel, kind: o.kind, ok: true, piece: state(o.post) } : { postId: o.postId, channel: o.channel, kind: o.kind, ok: false, reason: o.reason, problem: o.problem };

/**
 * The same shared fields sent to each chosen piece, each network taking what it has; one piece's
 * refusal never stops the others. The pieces named, not their whole channels: choosing the blog's
 * English article leaves the Spanish one alone. One at a time, as the engine's editPosts does.
 */
export function editMany(deps: PostActionDeps, input: unknown): Promise<Answer<PieceOutcome[]>> {
  return checked(
    () => editManyRequest(input),
    async ({ launchId, postIds, changes }) => {
      if (!(await deps.registry.get(launchId))) throw new PostRefused('not_found', 'no such launch');
      const editing = await deps.editing();
      const outcomes: PieceOutcome[] = [];
      for (const postId of postIds) {
        const post = await deps.registry.post(postId);
        if (!post || post.launchId !== launchId) {
          outcomes.push({ postId, channel: post?.channel ?? '', kind: post?.kind ?? '', ok: false, reason: 'not_found', problem: `post ${postId} is not a piece of this launch` });
          continue;
        }
        try {
          outcomes.push(outcome({ postId, channel: post.channel, kind: post.kind, ok: true, post: await editPost(postId, changes, editing, { strict: false }) }));
        } catch (error) {
          const reason = error instanceof PostRefused ? error.reason : 'failed';
          outcomes.push({ postId, channel: post.channel, kind: post.kind, ok: false, reason, problem: error instanceof Error ? error.message : String(error) });
        }
      }
      return outcomes;
    },
  );
}

/** Deletes every piece the launch has out, once the owner typed the repo's name; what cannot be deleted is reported */
export function deleteAll(deps: PostActionDeps, input: unknown): Promise<Answer<PieceOutcome[]>> {
  return checked(
    () => deleteAllRequest(input),
    async ({ launchId, confirm }) => {
      const launch = await deps.registry.get(launchId);
      if (!launch) throw new PostRefused('not_found', 'no such launch');
      if (confirm !== launch.repo) throw new InvalidInput(`type ${launch.repo} to confirm`);
      return (await deleteLaunchPosts(launchId, undefined, await deps.editing())).map(outcome);
    },
  );
}

export function schedule(deps: PostActionDeps, input: unknown): Promise<Answer<PieceState>> {
  return checked(
    () => scheduleRequest(input),
    async ({ launchId, channel, at }) => {
      const launch = await deps.registry.get(launchId);
      if (!launch) throw new ScheduleRefused('not_found', 'no such launch');
      // Best effort, as the API does: a launch.yml that cannot be read leaves the check to the publish step
      const config = await launchConfigOf(deps.github, deps.launchesRepo, launch).catch(() => undefined);
      const posts = await scheduleLaunch(deps.registry, launchId, { [channel]: at }, config ? { config } : {});
      await deps.armSchedule(posts);
      return state(posts[0]!);
    },
  );
}

export function move(deps: PostActionDeps, input: unknown): Promise<Answer<PieceState>> {
  return checked(
    () => moveRequest(input),
    async ({ postId, at }) => {
      const post = await reschedulePost(deps.registry, postId, at);
      await deps.armSchedule([post]);
      return state(post);
    },
  );
}

export function cancel(deps: PostActionDeps, input: unknown): Promise<Answer<PieceState>> {
  return checked(
    () => postRequest(input),
    async ({ postId }) => state(await cancelScheduledPost(deps.registry, postId)),
  );
}

export function recommend(deps: Pick<PostActionDeps, 'registry'>, input: unknown) {
  return checked(
    () => recommendRequest(input),
    async ({ channel }) => {
      const r = await recommendFor(deps.registry, channel, { days: 7, count: 5 });
      return { channel: r.channel, timezone: r.timezone, slots: r.slots.map((s) => ({ at: s.at, local: s.local, score: s.score, reason: s.reason })) };
    },
  );
}
