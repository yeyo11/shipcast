/*
 * The Comments page's filters, as the address carries them: the state (`state`), a channel, a launch,
 * a post, words to find (`q`) and the page. The address only ever holds what narrows the list, so
 * a default (all states, the first page) is left out and a view is a clean, shareable link.
 */

export const COMMENT_STATES = ['waiting', 'replied', 'ignored'] as const;
export type CommentState = (typeof COMMENT_STATES)[number];

export const COMMENT_STATE_NAMES: Record<CommentState, string> = { waiting: 'Waiting for a reply', replied: 'Replied', ignored: 'Ignored' };

export interface CommentsSearch {
  state?: CommentState;
  channel?: string;
  launch?: number;
  post?: number;
  q?: string;
  page?: number;
}

const whole = (value: unknown): number | undefined => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d{1,9}$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
};

/** What the address says, with anything that is not a filter dropped; never throws on a hand-edited link */
export function readCommentsSearch(search: Record<string, unknown>): CommentsSearch {
  const state = COMMENT_STATES.find((s) => s === search.state);
  const channel = typeof search.channel === 'string' && /^[A-Za-z]{1,40}$/.test(search.channel) ? search.channel : undefined;
  const q = typeof search.q === 'string' ? search.q.trim().slice(0, 200) : '';
  const launch = whole(search.launch);
  // A post belongs to its launch: a post alone in the address is read as no filter
  const post = launch ? whole(search.post) : undefined;
  const page = whole(search.page);
  return {
    ...(state && { state }),
    ...(channel && { channel }),
    ...(launch && { launch }),
    ...(post && { post }),
    ...(q && { q }),
    ...(page && page > 1 && { page }),
  };
}
