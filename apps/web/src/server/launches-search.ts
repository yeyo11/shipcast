/*
 * The Launches page's filters, as the address carries them: words to find (`q`), a status, what
 * started it (`trigger`), the pack (`kind`), a project (`repo`), the order (`sort`) and the page.
 * The address only ever holds what differs from the default (every launch, the newest first, the
 * first page), so a view is a clean, shareable link. Safe in the browser bundle: no imports.
 */

export const LAUNCH_STATUS_NAMES = {
  detected: 'Detected',
  generating: 'Drafting',
  drafted: 'Drafted',
  published: 'Published',
  skipped: 'Not launched',
  failed: 'Failed',
} as const;
export type LaunchStatusName = keyof typeof LAUNCH_STATUS_NAMES;

export const TRIGGER_NAMES = {
  release: 'A release',
  manual: 'By hand',
  public: 'Made public',
  enabled: 'Shipcast enabled',
  article: 'An article',
} as const;
export type TriggerName = keyof typeof TRIGGER_NAMES;

export const KIND_NAMES = { launch: 'First launch', major: 'Major version', minor: 'Minor version' } as const;
export type KindName = keyof typeof KIND_NAMES;

export const SORT_NAMES = { newest: 'Newest first', oldest: 'Oldest first' } as const;
export type LaunchSort = keyof typeof SORT_NAMES;

export interface LaunchesSearch {
  q?: string;
  status?: LaunchStatusName;
  trigger?: TriggerName;
  kind?: KindName;
  repo?: string;
  /** Only `oldest`: the newest first is the default and stays out of the address */
  sort?: 'oldest';
  page?: number;
}

const oneOf = <T extends string>(names: Record<T, string>, value: unknown): T | undefined =>
  typeof value === 'string' && Object.hasOwn(names, value) ? (value as T) : undefined;

const whole = (value: unknown): number | undefined => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d{1,9}$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
};

/** `owner/name` as GitHub allows it; anything else is not a repo to filter by */
export const isRepo = (value: string) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/.test(value);

/** What the address says, with anything that is not a filter dropped; never throws on a hand-edited link */
export function readLaunchesSearch(search: Record<string, unknown>): LaunchesSearch {
  const q = typeof search.q === 'string' ? search.q.trim().slice(0, 200) : '';
  const status = oneOf(LAUNCH_STATUS_NAMES, search.status);
  const trigger = oneOf(TRIGGER_NAMES, search.trigger);
  const kind = oneOf(KIND_NAMES, search.kind);
  const repo = typeof search.repo === 'string' && isRepo(search.repo) ? search.repo : undefined;
  const page = whole(search.page);
  return {
    ...(q && { q }),
    ...(status && { status }),
    ...(trigger && { trigger }),
    ...(kind && { kind }),
    ...(repo && { repo }),
    ...(search.sort === 'oldest' && { sort: 'oldest' as const }),
    ...(page && page > 1 && { page }),
  };
}

/** How many filters narrow the list, words and order aside: what the Filters button counts */
export const filtersSet = (search: LaunchesSearch) => (search.status ? 1 : 0) + (search.trigger ? 1 : 0) + (search.kind ? 1 : 0) + (search.repo ? 1 : 0);
