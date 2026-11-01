import { shortDay } from '../charts/data.ts';
import type { Metric, Period } from '../../server/stats-search.ts';

/* The Stats section's words: the names it writes, the period, ages and counts (no React, so tests run it) */

export const METRIC_NAMES: Record<Metric, string> = { views: 'Views', reactions: 'Reactions', comments: 'Comments', shares: 'Shares', clicks: 'Clicks', impressions: 'Impressions' };

export const PERIOD_CHIPS: Array<{ value: Exclude<Period, 'custom'>; label: string }> = [
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
  { value: 'all', label: 'All' },
];

/** The period as the chart's corner says it */
export function periodWords(period: Period, from: string, to: string): string {
  if (period === '7d') return 'Last 7 days';
  if (period === '30d') return 'Last 30 days';
  if (period === '90d') return 'Last 90 days';
  if (period === 'all') return 'Since the first launch';
  return `${shortDay(from)} – ${shortDay(to)}`;
}

/** The period as its chip says it */
export function periodChip(period: Period, from: string, to: string): string {
  return PERIOD_CHIPS.find((p) => p.value === period)?.label ?? `${shortDay(from)} – ${shortDay(to)}`;
}

/** How long ago, in the few words a card has room for: "2 h ago", "4 days ago" */
export function ago(iso: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (minutes < 60) return minutes <= 1 ? 'just now' : `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/** Whole days since a moment: how long an account has gone unread */
export const daysSince = (iso: string, now = Date.now()) => Math.max(1, Math.floor((now - Date.parse(iso)) / 86_400_000));

/** A count and its word, the word singular for one: "1 like", "38 likes", "1 reply" */
export function counted(value: number, word: string): string {
  const one = word.endsWith('ies') ? `${word.slice(0, -3)}y` : word.endsWith('s') ? word.slice(0, -1) : word;
  return `${value.toLocaleString('en')} ${value === 1 ? one : word}`;
}


/**
 * Rows that would read the same told apart: a repeated name takes its day ("· 20 Oct"), and one still
 * repeated its place among them ("· 2"), so a list never shows two rows nobody can tell apart.
 */
export function distinct(names: readonly string[], days: ReadonlyArray<string | null>): string[] {
  const count = (list: readonly string[]) => list.reduce((m, t) => m.set(t, (m.get(t) ?? 0) + 1), new Map<string, number>());
  const first = count(names);
  const dated = names.map((t, i) => ((first.get(t) ?? 0) > 1 && days[i] ? `${t} · ${shortDay(days[i] ?? '')}` : t));
  const second = count(dated);
  const seen = new Map<string, number>();
  return dated.map((t) => {
    if ((second.get(t) ?? 0) < 2) return t;
    const n = (seen.get(t) ?? 0) + 1;
    seen.set(t, n);
    return `${t} · ${n}`;
  });
}
