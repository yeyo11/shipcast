import { parseFailureKey } from '@shipcast/schema/failures';

/*
 * What needs the owner, as the top bar's bell lists it. Pure on purpose: the server function reads
 * a few small things (launches, failure cursors, accounts, the waiting comments, the dismissals) and
 * this turns them into the list and the count, so the rules are testable without a database.
 *
 * Every line has a key that names the condition it is about, its state included: a drafted launch
 * by its last change, a failure by its channels and messages, the waiting comments by the newest
 * one, a broken account by its problem, the scheduled posts by when the first goes out. A dismissed
 * line stays hidden while that condition lasts; when it changes the key changes and the line is new.
 * The dismissals of lines no longer there are forgotten, so a condition that ends and comes back
 * (an account that breaks again, the same failure after a retry) is shown again.
 */

export type AttentionKind = 'approve' | 'retry' | 'reply' | 'reconnect' | 'permission' | 'scheduled';

/** Where a line goes: typed per route, so the bell's links stay checked by the router */
export type AttentionTarget =
  | { to: '/launches/$id'; params: { id: string } }
  | { to: '/comments'; search: { state: 'waiting' } }
  | { to: '/channels'; search: { focus: string } }
  | { to: '/settings' };

export interface AttentionItem {
  key: string;
  kind: AttentionKind;
  /** What is the matter, in a short line */
  text: string;
  /** The link's own words: the verb the owner will do */
  action: string;
  target: AttentionTarget;
}

export interface AttentionInput {
  /** `updatedAt` moves with every change of status, so a launch drafted again is a new line */
  launches: ReadonlyArray<{ id: number; repo: string; ref: string; status: string; updatedAt: string }>;
  /** The `publish-failed:<launch>:<channel>` cursors, with the failure's message as their value */
  failures: ReadonlyArray<{ key: string; value: string }>;
  /** Accounts whose last check failed */
  brokenAccounts: ReadonlyArray<{ id: number; label: string; network: string; problem: string | null }>;
  commentsWaiting: number;
  /** The newest waiting comment's id: a comment arriving makes the line new again */
  newestWaitingComment?: number | null;
  scheduled: ReadonlyArray<{ launchId: number; scheduledAt: string | null }>;
  /**
   * The `metrics-problem:<source>:<subject>` cursors, with why the source refused as their value: a
   * reading the owner has to grant (the GitHub App's Administration: read for a repo's traffic)
   */
  metricProblems?: ReadonlyArray<{ key: string; value: string }>;
  now: Date;
  /** How far ahead a scheduled post is worth a line; a day by default */
  soonMs?: number;
  /** The keys the owner dismissed; those lines are left out of the list and the count */
  dismissed?: ReadonlySet<string>;
}

export interface Attention {
  /** What needs the owner: the scheduled lines are informational and not counted */
  count: number;
  items: AttentionItem[];
}

/** The lines that count: a scheduled post only informs */
export function countOf(items: readonly AttentionItem[]): number {
  return items.filter((i) => i.kind !== 'scheduled').length;
}

/** A short, stable digest (FNV-1a) of what a key depends on, so a long message never makes a long key */
export function digest(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/** What a dismissal may name: the shape of the keys below, and short, since a request can carry anything */
export const ATTENTION_KEY = /^(launch|comments|account|metrics):[\w.:-]{1,120}$/;

const DAY = 86_400_000;

export function launchName(repo: string, ref: string): string {
  return ref.startsWith('article:') ? 'An article' : `${repo.split('/')[1] ?? repo} ${ref}`;
}

export function soonIn(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return `${hours} h`;
}

/** Every line there is now, dismissed or not: the server keeps the dismissals of these and forgets the rest */
export function attentionItems(input: AttentionInput): AttentionItem[] {
  const byId = new Map(input.launches.map((l) => [l.id, l]));
  const failed = new Map<number, Array<{ channel: string; message: string }>>();
  for (const { key, value } of input.failures) {
    const parsed = parseFailureKey(key);
    if (parsed && byId.has(parsed.launchId)) failed.set(parsed.launchId, [...(failed.get(parsed.launchId) ?? []), { channel: parsed.channel, message: value }]);
  }

  const items: AttentionItem[] = [];
  for (const l of input.launches) {
    // A drafted launch with a failure is "Partly published": its need is the retry, not the approval
    if (l.status !== 'drafted' || failed.has(l.id)) continue;
    items.push({ key: `launch:${l.id}:waiting:${l.updatedAt}`, kind: 'approve', text: `${launchName(l.repo, l.ref)} waits for your approval`, action: 'Review the drafts', target: { to: '/launches/$id', params: { id: String(l.id) } } });
  }
  for (const [id, failures] of failed) {
    const l = byId.get(id);
    if (!l) continue;
    const names = failures.map((f) => f.channel).join(', ');
    // The launch's last change is in it too: a retry moves the launch, so failing again is a new line
    const state = digest(`${l.updatedAt}\n${failures.map((f) => `${f.channel}=${f.message}`).join('\n')}`);
    items.push({ key: `launch:${id}:failed:${state}`, kind: 'retry', text: `${launchName(l.repo, l.ref)} failed on ${names}`, action: 'Retry', target: { to: '/launches/$id', params: { id: String(id) } } });
  }
  if (input.commentsWaiting > 0) {
    const n = input.commentsWaiting;
    items.push({ key: `comments:waiting:${input.newestWaitingComment ?? n}`, kind: 'reply', text: n === 1 ? '1 comment waits for a reply' : `${n} comments wait for a reply`, action: 'Answer', target: { to: '/comments', search: { state: 'waiting' } } });
  }
  for (const a of input.brokenAccounts) {
    items.push({ key: `account:${a.id}:reconnect:${digest(a.problem ?? '')}`, kind: 'reconnect', text: `${a.label} (${a.network}) needs reconnecting`, action: 'Reconnect', target: { to: '/channels', search: { focus: String(a.id) } } });
  }
  for (const { key, value } of input.metricProblems ?? []) {
    const [, source = '', ...rest] = key.split(':');
    const subject = rest.join(':');
    // The key names the subject and why, so the same refusal stays dismissed and a new one is shown
    const id = `metrics:${source.replace(/[^\w-]/g, '')}:${digest(`${subject}\n${value}`)}`;
    if (source === 'github-traffic') {
      items.push({ key: id, kind: 'permission', text: `GitHub refuses ${subject}’s traffic: the App needs Administration: read on it`, action: 'Check the GitHub App', target: { to: '/settings' } });
    } else {
      items.push({ key: id, kind: 'permission', text: `${source} numbers of ${subject} cannot be read: ${value}`, action: 'See Settings', target: { to: '/settings' } });
    }
  }

  const horizon = input.now.getTime() + (input.soonMs ?? DAY);
  const soon = new Map<number, { n: number; at: number }>();
  for (const s of input.scheduled) {
    const at = s.scheduledAt ? Date.parse(s.scheduledAt) : NaN;
    if (!Number.isFinite(at) || at > horizon || !byId.has(s.launchId)) continue;
    const seen = soon.get(s.launchId);
    soon.set(s.launchId, { n: (seen?.n ?? 0) + 1, at: Math.min(seen?.at ?? at, at) });
  }
  for (const [id, { n, at }] of [...soon].sort((a, b) => a[1].at - b[1].at)) {
    const l = byId.get(id);
    if (!l) continue;
    const wait = at - input.now.getTime();
    const when = wait <= 0 ? 'any minute now' : `in ${soonIn(wait)}`;
    items.push({ key: `launch:${id}:scheduled:${at}:${n}`, kind: 'scheduled', text: `${n === 1 ? '1 post' : `${n} posts`} of ${launchName(l.repo, l.ref)} go out ${when}`, action: 'See it', target: { to: '/launches/$id', params: { id: String(id) } } });
  }
  return items;
}

export function buildAttention(input: AttentionInput): Attention {
  const dismissed = input.dismissed;
  const items = attentionItems(input).filter((i) => !dismissed?.has(i.key));
  return { count: countOf(items), items };
}

export function attentionLabel(count: number): string {
  return count === 0 ? 'Nothing needs you' : count === 1 ? '1 thing needs you' : `${count} things need you`;
}
