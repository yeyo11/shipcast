import type { DraftResult, Launch, PublishResult } from '@shipcast/engine';

/*
 * What the owner's devices are told by web push (docs/push.md), and in what words. A notification is
 * read on a lock screen, by anyone holding the phone, so its words are Shipcast's own: a release's
 * name, a count, a channel. Never a comment's text, a draft's or an article's title, nor a problem's
 * message (which may quote either): the page it opens has those, behind the session.
 */

/** The kinds of event a device can choose to be told of, in the order Settings lists them */
export const PUSH_EVENT_KINDS = ['comments', 'approval', 'failed', 'published'] as const;
export type PushEventKind = (typeof PUSH_EVENT_KINDS)[number];

/** What Settings says of each kind */
export const PUSH_EVENT_LABELS: Readonly<Record<PushEventKind, { label: string; help: string }>> = {
  comments: { label: 'Comments waiting for a reply', help: 'Replies drafted for new comments wait for your approval' },
  approval: { label: 'Drafts to review', help: 'A launch is drafted and waits for your approval' },
  failed: { label: 'Something failed', help: 'A launch could not be drafted, or a piece failed to go out' },
  published: { label: 'Launch published', help: 'Every channel of a launch is out' },
};

/** The launch an event is about, as far as a notification may name it */
export type LaunchName = Pick<Launch, 'repo' | 'ref'>;

export type PushEvent =
  | { kind: 'comments'; waiting: number }
  | { kind: 'approval'; launchId: number; launch: LaunchName }
  | { kind: 'failed'; launchId: number; launch: LaunchName; stage: 'draft' | 'publish'; channels?: readonly string[] }
  | { kind: 'published'; launchId: number; launch: LaunchName }
  /** "Send a test notification", from Settings: to the devices asked for, whatever they chose */
  | { kind: 'test' };

/** What the service worker shows: the title and body of the notification, and the app's path a tap opens */
export interface PushPayload {
  title: string;
  body: string;
  /** A path of the app, never another origin */
  url: string;
  /** Notifications with the same tag replace each other, so a launch never stacks its own */
  tag: string;
}

const MAX_NAME = 60;

/**
 * A launch as a notification names it: a release by its repo's name and tag ("claudio v0.9.0"). An
 * article's ref is its slug, made from a title that may not be public yet, so an article is only
 * "Your article"; a launch with no repo (made from sources) is "A launch".
 */
export function launchName(launch: LaunchName): string {
  if (launch.ref.startsWith('article:')) return 'Your article';
  const repo = launch.repo.split('/')[1] ?? '';
  if (!repo || !/^[\w.-]+$/.test(repo)) return 'A launch';
  const name = `${repo} ${launch.ref}`.replace(/\s+/g, ' ').trim();
  return name.length > MAX_NAME ? `${name.slice(0, MAX_NAME - 1)}…` : name;
}

/** Channel ids are Shipcast's own words (bluesky, devto); anything else is left out rather than echoed */
const channelList = (channels: readonly string[] = []) =>
  channels
    .filter((c) => /^[a-z][a-z0-9-]{1,30}$/.test(c))
    .slice(0, 4)
    .join(', ');

/** The notification an event is shown as */
export function pushPayload(event: PushEvent): PushPayload {
  switch (event.kind) {
    case 'comments': {
      const n = Math.max(1, Math.floor(event.waiting));
      return { title: 'Comments waiting', body: n === 1 ? 'A reply waits for your approval.' : `${n} replies wait for your approval.`, url: '/comments', tag: 'comments' };
    }
    case 'approval':
      return { title: 'Drafts to review', body: `${launchName(event.launch)} is drafted and waits for your approval.`, url: `/launches/${event.launchId}`, tag: `launch-${event.launchId}` };
    case 'failed': {
      const channels = channelList(event.channels);
      const body = event.stage === 'draft' ? `${launchName(event.launch)} could not be drafted.` : channels ? `${launchName(event.launch)} failed on ${channels}.` : `${launchName(event.launch)} failed to go out.`;
      return { title: 'Launch failed', body, url: `/launches/${event.launchId}`, tag: `launch-${event.launchId}` };
    }
    case 'published':
      return { title: 'Launch published', body: `${launchName(event.launch)} is out on every channel.`, url: `/launches/${event.launchId}`, tag: `launch-${event.launchId}` };
    case 'test':
      return { title: 'Shipcast', body: 'Notifications work on this device.', url: '/settings/notifications', tag: 'test' };
  }
}

/** Whether a device that chose `events` is told of this event: a kind it never set is on, and a test always goes */
export function wantsEvent(events: Readonly<Record<string, boolean>>, event: Pick<PushEvent, 'kind'>): boolean {
  return event.kind === 'test' || events[event.kind] !== false;
}

/** Each kind with its current choice, every kind present, for Settings and the API */
export function eventChoices(events: Readonly<Record<string, boolean>>): Record<PushEventKind, boolean> {
  return Object.fromEntries(PUSH_EVENT_KINDS.map((kind) => [kind, events[kind] !== false])) as Record<PushEventKind, boolean>;
}

/**
 * What a publish run tells the devices, or nothing: the launch is out on every channel, or a piece
 * failed for good. While only retryable failures happened and another attempt follows it says
 * nothing, as the owner's other notices do (the engine's publishNotice).
 */
export function publishEvent(launch: Launch, result: PublishResult, options: { final: boolean }): PushEvent | undefined {
  if (result.state === 'waiting' || result.state === 'skipped') return undefined;
  const willRetry = result.failures.some((f) => f.retryable) && !options.final;
  if (result.failures.length > 0 && !willRetry) return { kind: 'failed', launchId: launch.id, launch, stage: 'publish', channels: [...new Set(result.failures.map((f) => f.channel))] };
  if (result.state === 'published') return { kind: 'published', launchId: launch.id, launch };
  return undefined;
}

/** What a draft run tells the devices: the drafts wait for approval, or the drafting failed */
export function draftEvent(launch: Launch, result: Pick<DraftResult, 'ok'>, waiting: boolean): PushEvent | undefined {
  if (!result.ok) return { kind: 'failed', launchId: launch.id, launch, stage: 'draft' };
  return waiting ? { kind: 'approval', launchId: launch.id, launch } : undefined;
}
