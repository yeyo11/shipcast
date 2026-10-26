/*
 * What needs the owner, as the top bar's bell lists it. Pure on purpose: the server function reads
 * four small things (launches, failure cursors, accounts, a comment count) and this turns them into
 * the list and the count, so the rules are testable without a database.
 */

export type AttentionKind = 'approve' | 'retry' | 'reply' | 'reconnect' | 'scheduled';

/** Where a line goes: typed per route, so the bell's links stay checked by the router */
export type AttentionTarget =
  | { to: '/launches/$id'; params: { id: string } }
  | { to: '/comments'; search: { state: 'waiting' } }
  | { to: '/channels'; search: { focus: string } };

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
  launches: ReadonlyArray<{ id: number; repo: string; ref: string; status: string }>;
  /** The `publish-failed:<launch>:<channel>` cursor keys */
  failureKeys: readonly string[];
  /** Accounts whose last check failed */
  brokenAccounts: ReadonlyArray<{ id: number; label: string; network: string }>;
  commentsWaiting: number;
  scheduled: ReadonlyArray<{ launchId: number; scheduledAt: string | null }>;
  now: Date;
  /** How far ahead a scheduled post is worth a line; a day by default */
  soonMs?: number;
}

export interface Attention {
  /** What needs the owner: the scheduled lines are informational and not counted */
  count: number;
  items: AttentionItem[];
}

const DAY = 86_400_000;

export function launchName(repo: string, ref: string): string {
  return ref.startsWith('article:') ? 'An article' : `${repo.split('/')[1] ?? repo} ${ref}`;
}

/** `publish-failed:12:devto` into its launch and channel; anything else is not a failure */
export function parseFailureKey(key: string): { launchId: number; channel: string } | null {
  const match = /^publish-failed:(\d+):(.+)$/.exec(key);
  return match ? { launchId: Number(match[1]), channel: match[2] ?? '' } : null;
}

export function soonIn(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return `${hours} h`;
}

export function buildAttention(input: AttentionInput): Attention {
  const byId = new Map(input.launches.map((l) => [l.id, l]));
  const failed = new Map<number, string[]>();
  for (const key of input.failureKeys) {
    const parsed = parseFailureKey(key);
    if (parsed && byId.has(parsed.launchId)) failed.set(parsed.launchId, [...(failed.get(parsed.launchId) ?? []), parsed.channel]);
  }

  const items: AttentionItem[] = [];
  for (const l of input.launches) {
    // A drafted launch with a failure is "Partly published": its need is the retry, not the approval
    if (l.status !== 'drafted' || failed.has(l.id)) continue;
    items.push({ key: `approve:${l.id}`, kind: 'approve', text: `${launchName(l.repo, l.ref)} waits for your approval`, action: 'Review the drafts', target: { to: '/launches/$id', params: { id: String(l.id) } } });
  }
  for (const [id, channels] of failed) {
    const l = byId.get(id);
    if (!l) continue;
    const names = channels.join(', ');
    items.push({ key: `retry:${id}`, kind: 'retry', text: `${launchName(l.repo, l.ref)} failed on ${names}`, action: 'Retry', target: { to: '/launches/$id', params: { id: String(id) } } });
  }
  if (input.commentsWaiting > 0) {
    const n = input.commentsWaiting;
    items.push({ key: 'reply', kind: 'reply', text: n === 1 ? '1 comment waits for a reply' : `${n} comments wait for a reply`, action: 'Answer', target: { to: '/comments', search: { state: 'waiting' } } });
  }
  for (const a of input.brokenAccounts) {
    items.push({ key: `reconnect:${a.id}`, kind: 'reconnect', text: `${a.label} (${a.network}) needs reconnecting`, action: 'Reconnect', target: { to: '/channels', search: { focus: String(a.id) } } });
  }

  const count = items.length;

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
    items.push({ key: `scheduled:${id}`, kind: 'scheduled', text: `${n === 1 ? '1 post' : `${n} posts`} of ${launchName(l.repo, l.ref)} go out ${when}`, action: 'See it', target: { to: '/launches/$id', params: { id: String(id) } } });
  }

  return { count, items };
}

export function attentionLabel(count: number): string {
  return count === 0 ? 'Nothing needs you' : count === 1 ? '1 thing needs you' : `${count} things need you`;
}
