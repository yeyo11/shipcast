import type { ChannelEntry, PieceRow } from '../../server/pieces.ts';
import type { ChannelNumbers, Day } from '../../server/launch-summary.ts';
import type { Tone } from '../../server/view.ts';
import { zonedLabel } from '../../server/pieces.ts';
import { dayOnly, dayTime } from './dates.ts';

/*
 * The published launch's page as plain data (board LaunchDetail): each channel as one row with the
 * line under its name and the one number it leads with, the state pill's shape, what Unpublish
 * offers and the views chart's points. Pure, so the tests read the same rows the page draws.
 */

/** The state pill's class: the word's shape as well as its colour (drafting turns, failing is a diamond) */
export function pillClass(tone: Tone, status: string): string {
  if (status === 'generating' || status === 'detected') return 'k-p-run';
  switch (tone) {
    case 'published':
      return 'k-p-pub';
    case 'waiting':
      return 'k-p-wait';
    case 'failed':
      return 'k-p-fail';
    case 'quiet':
      return 'k-p-quiet';
    default:
      return 'k-p-draft';
  }
}

/** A metric's name as a figure's caption: `favourites` → favourites, `uniqueVisitors` → unique visitors */
export const metricCaption = (name: string) => name.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, (_, a: string, b: string) => `${a} ${b.toLowerCase()}`).toLowerCase();

export type RowKind = 'out' | 'failed' | 'scheduled' | 'waiting' | 'gone';

export interface ChannelRow {
  channel: string;
  kind: RowKind;
  /** The line under the channel's name */
  line: string;
  /** The number the row leads with, and what it counts */
  figure: { value: number; caption: string } | null;
  /** Where the piece is on its network, for the name's link */
  url: string | null;
  /** The pieces Edit selected can change */
  editable: PieceRow[];
  /** The piece waiting for its time, which Move moves */
  scheduled: { id: number; scheduledAt: string | null } | null;
}

/** The number a channel's row leads with: its pieces' own metric, else what the launch's numbers count there */
function figureOf(pieces: readonly PieceRow[], numbers: ChannelNumbers | undefined): ChannelRow['figure'] {
  const first = pieces.find((p) => p.metric)?.metric;
  if (first) {
    const value = pieces.reduce((sum, p) => sum + (p.metric?.name === first.name ? p.metric.value : 0), 0);
    return { value, caption: metricCaption(first.name) };
  }
  if (numbers?.totals.views !== undefined) return { value: numbers.totals.views, caption: 'views' };
  if (numbers?.site) return { value: numbers.site.visits, caption: 'visits' };
  return null;
}

/** One row per channel, as the board lists them: what went out, what failed, what waits for its time */
export function channelRows(entries: readonly ChannelEntry[], numbers: Readonly<Record<string, ChannelNumbers>>, timezone: string): ChannelRow[] {
  return entries.map((e) => {
    const out = e.pieces.filter((p) => p.status === 'live' || p.status === 'edited');
    const piece = e.pieces.find((p) => p.status === 'scheduled');
    const scheduled = piece ? { id: piece.id, scheduledAt: piece.scheduledAt } : (e.scheduling?.scheduled ?? null);
    const scheduledAt = scheduled?.scheduledAt ?? null;
    const editable = e.pieces.filter((p) => p.edit.allowed);
    const url = (out.find((p) => p.url) ?? e.pieces.find((p) => p.url))?.url ?? null;
    const base = { channel: e.channel, url, editable, scheduled };
    if (e.failure !== undefined) return { ...base, kind: 'failed', line: `Failed: ${e.failure}`, figure: null };
    if (out.length > 0) {
      const latest = out.reduce((a, b) => (a.publishedAt <= b.publishedAt ? a : b));
      const edited = out.find((p) => p.status === 'edited');
      const when = edited ? `Edited ${dayTime(edited.updatedAt, timezone)}` : `Published ${dayTime(latest.publishedAt, timezone)}`;
      const line = out.length < e.pieces.length ? `${e.label} · ${when.charAt(0).toLowerCase()}${when.slice(1)}` : when;
      return { ...base, kind: 'out', line, figure: figureOf(out, numbers[e.channel]) };
    }
    if (scheduledAt) return { ...base, kind: 'scheduled', line: `Scheduled ${zonedLabel(scheduledAt, timezone)}`, figure: null };
    if (e.pieces.length > 0 && e.pieces.every((p) => p.status === 'deleted')) return { ...base, kind: 'gone', line: e.label, figure: null };
    return { ...base, kind: 'waiting', line: e.label, figure: null };
  });
}

/**
 * The pieces still waiting for their time, as the scheduling the channel rows read: the page's rows
 * hold only what went out, and a published launch's scheduling only what a drafted one can still set
 */
export function withScheduled(
  scheduling: ReadonlyArray<{ channel: string; scheduled: { id: number; status: string; updatedAt: string; scheduledAt: string | null } | null }>,
  posts: ReadonlyArray<{ id: number; channel: string; status: string; publishedAt: string; scheduledAt: string | null }>,
) {
  const extra = posts
    .filter((p) => p.status === 'scheduled' && !scheduling.some((s) => s.channel === p.channel))
    .map((p) => ({ channel: p.channel, scheduled: { id: p.id, status: p.status, updatedAt: p.publishedAt, scheduledAt: p.scheduledAt } }));
  return [...scheduling, ...extra];
}

/** A channel Unpublish can take down: its pieces still out that its network lets go */
export interface UnpublishGroup {
  channel: string;
  pieces: PieceRow[];
  /** What the tick takes, where the name alone does not say it */
  note: string | null;
}

export function unpublishGroups(rows: readonly PieceRow[]): UnpublishGroup[] {
  const order: string[] = [];
  for (const r of rows) if (r.remove.allowed && !order.includes(r.channel)) order.push(r.channel);
  return order.map((channel) => {
    const pieces = rows.filter((r) => r.channel === channel && r.remove.allowed);
    const unpublish = pieces.some((p) => p.remove.verb === 'Unpublish');
    const note =
      channel === 'blog'
        ? pieces.length > 1
          ? `The article, ${pieces.length === 2 ? 'both' : `all ${pieces.length}`} languages`
          : 'The article'
        : unpublish
          ? 'Unpublished: the network keeps a private copy'
          : pieces.length > 1
            ? `${pieces.length} pieces`
            : null;
    return { channel, pieces, note };
  });
}

/**
 * The Channels tab's select-all tick: only rows with something to edit can be ticked, so "all" is
 * every one of those. `state` drives the tick (checked, indeterminate or clear) and `next` is what a
 * press leaves ticked: everything when not all were, nothing when all were.
 */
export function selectAll(rows: ReadonlyArray<Pick<ChannelRow, 'channel' | 'editable'>>, ticked: readonly string[]): { tickable: string[]; state: 'all' | 'some' | 'none'; next: string[] } {
  const tickable = rows.filter((r) => r.editable.length > 0).map((r) => r.channel);
  const on = tickable.filter((c) => ticked.includes(c)).length;
  const state = tickable.length > 0 && on === tickable.length ? 'all' : on > 0 ? 'some' : 'none';
  return { tickable, state, next: state === 'all' ? [] : tickable };
}

/** A list in words: `a`, `a and b`, `a, b and c` */
export function listWords(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/** The views chart's line on a box `width` × `height`, with its baseline at `base` and the peak at `top` */
export function chartPoints(days: readonly Day[], width: number, base = 100, top = 18): { points: Array<[number, number]>; peak: { x: number; y: number; views: number; day: string } | null } {
  if (days.length === 0) return { points: [], peak: null };
  const max = Math.max(1, ...days.map((d) => d.views));
  const step = days.length > 1 ? width / (days.length - 1) : 0;
  const points = days.map((d, i): [number, number] => [Math.round(i * step * 10) / 10, Math.round((base - (d.views / max) * (base - top)) * 10) / 10]);
  let at = 0;
  days.forEach((d, i) => {
    if (d.views > days[at]!.views) at = i;
  });
  const [x, y] = points[at]!;
  return { points, peak: { x, y, views: days[at]!.views, day: days[at]!.day } };
}

/** A chart day (`2026-10-21`) as the peak's label reads it: `21 Oct` */
export const chartDay = (day: string) => dayOnly(`${day}T12:00:00Z`, 'UTC');

/**
 * Where the launch's Views come from, channel by channel, largest first: the headline adds up every
 * channel's views (the newsletter's are its opens) while each row leads with its own metric, so the
 * card names its parts rather than leave a total the rows do not visibly add up to.
 */
export function viewSources(channels: Readonly<Record<string, ChannelNumbers>>, nameOf: (channel: string) => string): Array<{ channel: string; label: string; views: number }> {
  return Object.entries(channels)
    .flatMap(([channel, n]) => {
      const views = n.totals.views ?? 0;
      return views > 0 ? [{ channel, label: channel === 'newsletter' ? `${nameOf(channel)} opens` : nameOf(channel), views }] : [];
    })
    .sort((a, b) => b.views - a.views || a.label.localeCompare(b.label));
}
