import { readCommentsSearch, type CommentsSearch, type CommentState } from './comments-search.ts';

/*
 * The Comments inbox as the page reads it, plain data the page and the tests share: which tab the
 * address opens (Waiting unless it says otherwise, since what waits for the owner comes first), the
 * comment opened to reply to in place, the short times the board writes ("2 h"), and when the next
 * scheduled read is. Safe in the browser bundle: nothing here touches the server.
 */

/** The inbox's tabs: the three states the list is split by, and every comment */
export type InboxTab = CommentState | 'all';

export const INBOX_TABS: ReadonlyArray<{ tab: InboxTab; label: string }> = [
  { tab: 'waiting', label: 'Waiting' },
  { tab: 'replied', label: 'Answered' },
  { tab: 'ignored', label: 'Dismissed' },
  { tab: 'all', label: 'All' },
];

/** The address of the inbox: the list's filters, its tab (`state`, `all` for every comment) and the comment open to reply to */
export interface InboxSearch extends Omit<CommentsSearch, 'state'> {
  state?: InboxTab;
  reply?: number;
}

/** What the address says, never throwing on a hand-edited link; Waiting is the default tab, so it is left out */
export function readInboxSearch(search: Record<string, unknown>): InboxSearch {
  const { state, ...rest } = readCommentsSearch(search);
  const tab: InboxTab | undefined = search.state === 'all' ? 'all' : state;
  const reply = typeof search.reply === 'number' ? search.reply : typeof search.reply === 'string' && /^\d{1,9}$/.test(search.reply) ? Number(search.reply) : NaN;
  return {
    ...rest,
    ...(tab && tab !== 'waiting' && { state: tab }),
    ...(Number.isSafeInteger(reply) && reply > 0 && { reply }),
  };
}

/** The tab the address opens */
export const inboxTab = (search: Pick<InboxSearch, 'state'>): InboxTab => search.state ?? 'waiting';

/** The list's filters for the server: the tab as a state (none for All), the open comment apart */
export function listFilter(search: InboxSearch): CommentsSearch {
  const { state, reply: _reply, ...rest } = search;
  const tab = state ?? 'waiting';
  return { ...rest, ...(tab !== 'all' && { state: tab }) };
}

/** How long ago, as the board writes it beside a name: `now`, `12 min`, `2 h`, `3 d`, then the date */
export function ago(iso: string, now: Date): string {
  const ms = now.getTime() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} d`;
  const date = new Date(iso);
  const sameYear = date.getUTCFullYear() === now.getUTCFullYear();
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(!sameYear && { year: 'numeric' }), timeZone: 'UTC' });
}

/** Minutes to the next scheduled read: the job runs every half hour, on the hour and the half hour, in UTC (runtime's COMMENTS_CRON) */
export function nextCheckIn(now: Date): number {
  const into = (now.getUTCMinutes() % 30) * 60_000 + now.getUTCSeconds() * 1000 + now.getUTCMilliseconds();
  return Math.max(1, Math.ceil((30 * 60_000 - into) / 60_000));
}

/** Where an open comment stands in the list it was opened from: `1 of 2 waiting`, and the next one to open */
export function position<T extends { id: number }>(list: readonly T[], id: number, total: number, tab: InboxTab): { label: string | null; next: T | undefined } {
  const at = list.findIndex((c) => c.id === id);
  if (at < 0) return { label: null, next: undefined };
  const word = tab === 'waiting' ? ' waiting' : tab === 'replied' ? ' answered' : tab === 'ignored' ? ' dismissed' : '';
  return { label: `${at + 1} of ${total}${word}`, next: list[at + 1] };
}

/** A comment's state as a word and a shape (the board's pills) */
export const COMMENT_PILLS: Record<string, { label: string; pill: string }> = {
  new: { label: 'Drafting', pill: 'k-p-run' },
  'draft-ready': { label: 'Draft ready', pill: 'k-p-wait' },
  approved: { label: 'Sending', pill: 'k-p-run' },
  sent: { label: 'Answered', pill: 'k-p-pub' },
  dismissed: { label: 'Dismissed', pill: 'k-p-quiet' },
  failed: { label: 'Failed', pill: 'k-p-fail' },
};

export const CLASS_NAMES: Record<string, string> = {
  question: 'Question',
  feedback: 'Feedback',
  praise: 'Praise',
  bug: 'Bug',
  spam: 'Spam',
  abuse: 'Abuse',
  other: 'Other',
};
