/*
 * The Launches page's layout as plain data (docs/web-app.md): what waits for the owner leaves the
 * grid for slim rows above it, so the grid holds only launches that went out and every card in it
 * can be the same height. Safe in the browser bundle: no imports.
 */

/** Where a launch shows on the list */
export type LaunchLane =
  /** Drafts waiting in the pull request for the owner's approval: the yellow row */
  | 'approval'
  /** Not out and not waiting for the owner (drafting, or not launched): a quiet dashed row */
  | 'pending'
  /** Gone out, whole, in part or failing: a card in the grid */
  | 'out';

interface Laneable {
  status: string;
  state: { tone: string };
}

export function laneOf(launch: Laneable): LaunchLane {
  // A drafted launch with failures has partly gone out: it is a card, with its failures on it
  if (launch.status === 'drafted') return launch.state.tone === 'waiting' ? 'approval' : 'out';
  if (launch.status === 'detected' || launch.status === 'generating' || launch.status === 'skipped') return 'pending';
  return 'out';
}

/** The list split by lane, each keeping the list's own order (newest first) */
export function splitLaunches<T extends Laneable>(launches: readonly T[]): Record<LaunchLane, T[]> {
  const lanes: Record<LaunchLane, T[]> = { approval: [], pending: [], out: [] };
  for (const l of launches) lanes[laneOf(l)].push(l);
  return lanes;
}

/**
 * The project's picture: the GitHub avatar of the repo's owner, public and without a token. A
 * `logo:` in launch.yml would come first once it exists (future work, docs/web-app.md).
 */
export function ownerAvatarUrl(repo: string): string | null {
  const owner = repo.split('/')[0] ?? '';
  // GitHub logins are letters, digits and single hyphens; anything else is not asked for
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(owner)) return null;
  return `https://avatars.githubusercontent.com/${owner}?size=80`;
}

/** The name a launch goes by on the list: the project, or an article's title as its slug spells it */
export function launchTitle(launch: { repo: string; ref: string; title?: string | null }): { title: string; version: string | null; article: boolean } {
  if (launch.ref.startsWith('article:')) {
    // The title the launch model keeps; the slug only when it has none
    const kept = launch.title?.trim();
    if (kept) return { title: kept, version: null, article: true };
    const words = launch.ref.slice('article:'.length).replace(/[-_]+/g, ' ').trim();
    return { title: words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Article', version: null, article: true };
  }
  return { title: launch.repo.split('/')[1] ?? launch.repo, version: launch.ref, article: false };
}

/**
 * A launch's name in one string, where a page's title, a back link or a toast names it: an article's
 * title (launchTitle), a release's project and version ("Claudio v1.5.0", capitalised as a heading is)
 */
export function launchName(launch: { repo: string; ref: string; title?: string | null }): string {
  const { title, version } = launchTitle(launch);
  const named = title.charAt(0).toUpperCase() + title.slice(1);
  return version ? `${named} ${version}` : named;
}

/** A list in words: "a, b and c" */
export function wordList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/**
 * What a launch waiting for approval has ready, by channel, in the order a reader takes them: the
 * article first (its languages are one piece to the owner), then each network as its drafts list it.
 * `names` turns a channel into its network's name.
 */
export function readyPieces(channels: readonly string[], names: (channel: string) => string): { count: number; text: string } {
  const unique = [...new Set(channels)];
  const ordered = [...unique.filter((c) => c === 'blog'), ...unique.filter((c) => c !== 'blog')];
  const words = ordered.map((c) => (c === 'blog' ? 'the article' : names(c)));
  return { count: ordered.length, text: wordList(words) };
}

/** How long ago, as the cards say it: "3 min ago", "2 h ago", "yesterday", then the days */
export function agoLabel(iso: string, now: Date = new Date()): string {
  const ms = Math.max(0, now.getTime() - new Date(iso).getTime());
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

/** Who started a launch, after "started … by": the release, or the owner */
export const TRIGGER_BY: Record<string, string> = {
  release: 'the release',
  manual: 'you',
  public: 'the repo going public',
  enabled: 'Shipcast being enabled',
  article: 'you',
};

/**
 * What a launch being drafted is doing now, from its job's last line: the clause before any aside
 * ("Reading the code and writing the pack; this takes…" reads "Reading the code and writing the pack").
 */
export function draftingNote(log: readonly string[]): string {
  const last = log.at(-1)?.trim() ?? '';
  const clause = last.split(/[;:…]/)[0]?.trim().replace(/\.+$/, '') ?? '';
  return clause || 'Drafting';
}

/** A day as the cards say it, in the owner's time zone: "20 Oct", with the year when it is not this one */
export function shortDate(iso: string, timeZone: string, now: Date = new Date()): string {
  const at = new Date(iso);
  const year = (d: Date) => new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric' }).format(d);
  const sameYear = year(at) === year(now);
  return new Intl.DateTimeFormat('en-GB', { timeZone, day: 'numeric', month: 'short', ...(!sameYear && { year: 'numeric' }) }).format(at);
}

/** A day and a time as the peek's lines say them: "20 Oct, 12:00" */
export function shortDateTime(iso: string, timeZone: string, now: Date = new Date()): string {
  const time = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
  return `${shortDate(iso, timeZone, now)}, ${time}`;
}

/**
 * Where a launch shows on the Launches page (docs/plans/redesign.md):
 * - `approval`: its drafts wait for the owner, the yellow card on top (not while the list is narrowed
 *   by a search or a filter: then it is a card among the others);
 * - `card`: it is drafting, or something of it went out or has numbers: a card in the grid;
 * - `quiet`: nothing of it went out and it has no numbers (not launched, failed before anything went
 *   out, every piece taken down): a one-line row in the "Not published" group below the grid.
 * A failed launch with nothing out keeps a card only while what needs you does not list it already,
 * so one failure is never shown twice.
 */
export type HomeGroup = 'approval' | 'card' | 'quiet';

export interface Groupable {
  id: number;
  status: string;
  state: { tone: string };
  posts: ReadonlyArray<{ status: string }>;
  numbers: { totals: { views: number; reactions: number; comments: number; clicks: number } } | null;
}

/** A piece out there, or on its way at a set time */
const OUT = new Set(['live', 'edited', 'scheduled']);

export function homeGroupOf(launch: Groupable, context: { narrowed: boolean; listedFailures: ReadonlySet<number> }): HomeGroup {
  if (launch.status === 'detected' || launch.status === 'generating') return 'card';
  if (launch.status === 'drafted' && launch.state.tone === 'waiting') return context.narrowed ? 'card' : 'approval';
  const t = launch.numbers?.totals;
  const counted = t !== undefined && t.views + t.reactions + t.comments + t.clicks > 0;
  if (counted || launch.posts.some((p) => OUT.has(p.status))) return 'card';
  if (launch.state.tone === 'failed') return context.listedFailures.has(launch.id) ? 'quiet' : 'card';
  return 'quiet';
}

/** The page's launches by group, each keeping the list's own order (newest first) */
export function homeGroups<T extends Groupable>(launches: readonly T[], context: { narrowed: boolean; listedFailures: ReadonlySet<number> }): Record<HomeGroup, T[]> {
  const groups: Record<HomeGroup, T[]> = { approval: [], card: [], quiet: [] };
  for (const l of launches) groups[homeGroupOf(l, context)].push(l);
  return groups;
}

/** The launches what needs you already lists as failed, from its lines' keys (`launch:<id>:failed:…`) */
export function listedFailures(items: ReadonlyArray<{ key: string; kind: string }>): Set<number> {
  const ids = new Set<number>();
  for (const i of items) {
    const id = failedLaunchOf(i);
    if (id !== null) ids.add(id);
  }
  return ids;
}

/** The launch a "failed" line of what needs you is about, or null for any other line */
export function failedLaunchOf(item: { key: string; kind: string }): number | null {
  const id = item.kind === 'retry' ? /^launch:(\d+):failed:/.exec(item.key)?.[1] : undefined;
  return id ? Number(id) : null;
}

/**
 * Whether a launch can be launched again as it is (the launch page's "Launch it again"): a release
 * that failed before anything went out. An article is written again in Write instead.
 */
export function canRelaunch(launch: { status: string; ref: string; posts: readonly unknown[] }): boolean {
  return launch.status === 'failed' && !launch.ref.startsWith('article:') && launch.posts.length === 0;
}

/** A card's channel mark (`.home-mark`: 8 + 15 + 6 + 10 + 8 px and its 2 px borders) and the gap after it */
export const HOME_MARK = 51;
export const HOME_MARK_GAP = 6;
/** At most this many marks on a card's one row; the rest fold behind "+n" */
export const HOME_MARKS_MAX = 6;

/** How many marks a row of `width` px holds, between one and the most a card shows */
export function homeMarkFit(width: number): number {
  return Math.min(HOME_MARKS_MAX, Math.max(1, Math.floor((Math.max(0, width) + HOME_MARK_GAP) / (HOME_MARK + HOME_MARK_GAP))));
}

/**
 * The launch a line of what needs you may delete from its ⋯: only one that failed before anything
 * went out, so a warning line never hides a launch that published. Null for every other line.
 */
export function deletableFromLine(item: { key: string; kind: string; nothingOut?: boolean }): number | null {
  return item.nothingOut ? failedLaunchOf(item) : null;
}
