import { Refused, type Channel, type LaunchConfig } from '@shipcast/schema';
import { cancelledKey, PUBLISHED_BY_ENGINE } from './publish.ts';
import type { ScheduleStore, SettingStore } from './ports.ts';
import type { Post } from './registry.ts';

/*
 * Scheduled publishing: a channel's piece of a launch can wait for a time instead of going out as
 * soon as the launch is published. The time lives on the piece's own row (`posts`, status
 * `scheduled`, `scheduled_at` in UTC), so the uniqueness that makes a launch happen once covers it,
 * and the publish step decides at every run whether it is due. A job of the queue wakes the
 * publishing up at that moment; a round that finds it overdue (the machine was off) publishes it
 * then. See docs/scheduling.md
 */

/** The setting that holds the owner's IANA time zone, which the recommendation speaks in */
export const TIMEZONE_KEY = 'timezone';
export const DEFAULT_TIMEZONE = 'Europe/Madrid';

/** Why a schedule was refused: no such launch or post, an input that is not valid, or a state that does not allow it */
export class ScheduleRefused extends Refused<'not_found' | 'invalid' | 'refused'> {
  override name = 'ScheduleRefused';
}

/**
 * Whether a name is an IANA zone (`Europe/Madrid`, `America/New_York`, `UTC`). Intl also takes
 * offsets such as `+01:00`, which have no summer time and so would put every slot an hour off for
 * half the year; they are refused.
 */
export function isTimeZone(name: unknown): name is string {
  if (typeof name !== 'string' || name.length > 64) return false;
  if (!/^(?:UTC|GMT|[A-Za-z]+(?:\/[A-Za-z0-9_+-]+){1,2})$/.test(name)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/** The owner's time zone, or Madrid until one is set */
export async function readTimezone(registry: Pick<SettingStore, 'setting'>): Promise<string> {
  const stored = await registry.setting<string>(TIMEZONE_KEY);
  return isTimeZone(stored) ? stored : DEFAULT_TIMEZONE;
}

export async function saveTimezone(registry: SettingStore, name: unknown): Promise<string> {
  if (!isTimeZone(name)) throw new ScheduleRefused('invalid', 'timezone is an IANA zone such as Europe/Madrid');
  await registry.setSetting(TIMEZONE_KEY, name);
  return name;
}

/**
 * The channels a time can be set for: those the engine publishes itself, but not the blog, published
 * by the merge, nor Reddit, whose launch is one post per subreddit and a schedule is one row per channel
 */
export const SCHEDULABLE_CHANNELS: readonly Channel[] = PUBLISHED_BY_ENGINE.filter((c) => c !== 'reddit');

/** How far ahead a time may be: a launch's pieces belong to its week, and pg-boss keeps a queued job a fortnight past its start */
export const MAX_SCHEDULE_DAYS = 60;

function when(value: Date, now: Date): Date {
  if (Number.isNaN(value.getTime())) throw new ScheduleRefused('invalid', 'a time is an ISO 8601 date-time');
  if (value.getTime() - now.getTime() > MAX_SCHEDULE_DAYS * 86_400_000) throw new ScheduleRefused('invalid', `a time is at most ${MAX_SCHEDULE_DAYS} days ahead`);
  // A time already past is "as soon as it can": the next publish run sends it, as a missed slot
  return value;
}

export interface ScheduleOptions {
  now?: Date;
  /** The launch's launch.yml when it can be read: a channel it sets to off is refused */
  config?: LaunchConfig;
}

/**
 * Sets the time of each named channel's piece of a launch. Each is a scheduled row; one already
 * scheduled is moved. Refused as a whole, before anything is written, when a channel cannot be
 * scheduled: not one the engine publishes, off in launch.yml, or already out.
 */
export async function scheduleLaunch(registry: ScheduleStore, launchId: number, times: Partial<Record<Channel, Date>>, options: ScheduleOptions = {}): Promise<Post[]> {
  const now = options.now ?? new Date();
  const launch = await registry.get(launchId);
  if (!launch) throw new ScheduleRefused('not_found', 'no such launch');
  if (launch.status === 'published' || launch.status === 'skipped' || launch.status === 'failed') {
    throw new ScheduleRefused('refused', `the launch is ${launch.status}: nothing of it is waiting to go out`);
  }
  const entries = Object.entries(times) as Array<[Channel, Date]>;
  if (entries.length === 0) throw new ScheduleRefused('invalid', 'name at least one channel and its time');
  const pieces = await registry.posts(launchId);
  for (const [channel, at] of entries) {
    if (!SCHEDULABLE_CHANNELS.includes(channel)) throw new ScheduleRefused('invalid', `${channel} is not published by Shipcast, so it has no time; the channels are ${SCHEDULABLE_CHANNELS.join(', ')}`);
    const mode = options.config?.publishing[channel];
    if (mode === 'off') throw new ScheduleRefused('refused', `${channel} is off in launch.yml: Shipcast does not publish it`);
    if (pieces.some((p) => p.channel === channel && p.status !== 'scheduled')) throw new ScheduleRefused('refused', `${channel} is out already: a launch happens once`);
    when(at, now);
  }
  const scheduled: Post[] = [];
  for (const [channel, at] of entries) {
    // Scheduling again what was cancelled brings it back
    await registry.deleteCursor(cancelledKey(launchId, channel));
    const post = await registry.schedulePost(launchId, channel, at);
    if (!post) throw new ScheduleRefused('refused', `${channel} went out while it was being scheduled`);
    scheduled.push(post);
  }
  return scheduled;
}

async function scheduledPost(registry: ScheduleStore, postId: number): Promise<Post> {
  const post = await registry.post(postId);
  if (!post) throw new ScheduleRefused('not_found', 'no such post');
  if (post.status !== 'scheduled') throw new ScheduleRefused('refused', `post ${postId} is ${post.status}, not scheduled`);
  return post;
}

/** Moves a scheduled piece to another time; a time already past sends it on the next publish run */
export async function reschedulePost(registry: ScheduleStore, postId: number, at: Date, options: { now?: Date } = {}): Promise<Post> {
  await scheduledPost(registry, postId);
  const moved = await registry.reschedulePost(postId, when(at, options.now ?? new Date()));
  if (!moved) throw new ScheduleRefused('refused', `post ${postId} went out while it was being moved`);
  return moved;
}

/**
 * Cancels a scheduled piece: its row goes and its channel is not published for that launch, until
 * it is scheduled again. To send it now instead, move it to now.
 */
export async function cancelScheduledPost(registry: ScheduleStore, postId: number): Promise<Post> {
  const post = await scheduledPost(registry, postId);
  const removed = await registry.unschedulePost(postId);
  if (!removed) throw new ScheduleRefused('refused', `post ${postId} went out while it was being cancelled`);
  await registry.setCursor(cancelledKey(post.launchId, post.channel), new Date().toISOString());
  return removed;
}
