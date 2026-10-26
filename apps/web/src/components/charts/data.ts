/*
 * The charts' arithmetic, kept apart from the drawing so it can be tested without a browser: series
 * aligned to the buckets, the comparison period laid over the current one, stacks, the value scale's
 * top, the keyboard's moves through the points, the brush's range and the CSV a chart exports.
 * See docs/decisions/charts.md
 */

export type ChartKind = 'line' | 'area' | 'bar';

/** One series as a chart draws it: a value per bucket, the same length as the chart's buckets */
export interface ChartSeries {
  key: string;
  label: string;
  /** A CSS colour, normally a `var(--chart-…)` from palette.ts */
  colour: string;
  /** Null where nothing was read (an account's missed day): a line breaks there, a stack counts it as zero */
  values: Array<number | null>;
  /** The comparison period's values, bucket by bucket; null where it has no bucket */
  comparison?: Array<number | null>;
}

/** A point as the engine gives it: the bucket's first day and how much the metric grew in it */
export interface BucketPoint {
  bucket: string;
  increase: number;
}

/**
 * The values of a series on the chart's buckets, zero where it has no point. The engine's series are
 * dense already, but a chart must never trust that two series line up by position.
 */
export function alignToBuckets(buckets: readonly string[], points: readonly BucketPoint[]): number[] {
  const byBucket = new Map(points.map((p) => [p.bucket, p.increase]));
  return buckets.map((bucket) => byBucket.get(bucket) ?? 0);
}

/**
 * The previous period laid over the current one, bucket by bucket: its first bucket under the
 * current first one. The two periods have the same length, but weeks can split them into a different
 * number of buckets; a bucket with no counterpart is null, so a line breaks there rather than
 * dropping to zero.
 */
export function overlayComparison(length: number, previous: readonly number[]): Array<number | null> {
  return Array.from({ length }, (_, i) => previous[i] ?? null);
}

/** The series' values summed bucket by bucket: what a stack's top and the comparison's total are */
export function totals(series: readonly ChartSeries[], length: number): number[] {
  return Array.from({ length }, (_, i) => series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0));
}

/** The comparison period's total per bucket, null where no series has a comparison value there */
export function comparisonTotals(series: readonly ChartSeries[], length: number): Array<number | null> {
  return Array.from({ length }, (_, i) => {
    let seen = false;
    let sum = 0;
    for (const s of series) {
      const v = s.comparison?.[i];
      if (v === null || v === undefined) continue;
      seen = true;
      sum += v;
    }
    return seen ? sum : null;
  });
}

/** Each series' band in a stack, bottom (y0) and top (y1) per bucket, in the order given */
export function stack(series: readonly ChartSeries[], length: number): Array<{ key: string; y0: number[]; y1: number[] }> {
  const floor = new Array<number>(length).fill(0);
  return series.map((s) => {
    const y0 = [...floor];
    const y1 = y0.map((base, i) => base + Math.max(0, s.values[i] ?? 0));
    for (let i = 0; i < length; i++) floor[i] = y1[i]!;
    return { key: s.key, y0, y1 };
  });
}

/**
 * The top of the value axis: the highest thing drawn (a series, a stack, the comparison) rounded up
 * to a 1, 2, 2.5 or 5 step, so the grid lines land on numbers people read at a glance. Never below 1,
 * so a period with nothing in it still has an axis.
 */
export function valueCeiling(series: readonly ChartSeries[], kind: ChartKind, length: number): number {
  const stacked = kind !== 'line';
  let top = 0;
  if (stacked) {
    for (const v of totals(series, length)) top = Math.max(top, v);
    for (const v of comparisonTotals(series, length)) if (v !== null) top = Math.max(top, v);
  } else {
    for (const s of series) {
      for (const v of [...s.values, ...(s.comparison ?? [])]) if (v !== null) top = Math.max(top, v);
    }
  }
  return niceCeiling(top);
}

/**
 * The value axis for levels rather than increases (an account's followers): from just under the
 * lowest to just over the highest, so a change of ten on two thousand still shows as a slope.
 */
export function levelDomain(series: readonly ChartSeries[]): [number, number] {
  const seen = series.flatMap((s) => s.values).filter((v): v is number => v !== null);
  if (seen.length === 0) return [0, 1];
  const lo = Math.min(...seen);
  const hi = Math.max(...seen);
  const pad = Math.max(1, Math.ceil((hi - lo) * 0.1));
  return [Math.max(0, Math.floor(lo - pad)), Math.ceil(hi + pad)];
}

export function niceCeiling(value: number): number {
  if (!(value > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) if (step * magnitude >= value) return step * magnitude;
  return 10 * magnitude;
}

/**
 * Where the keyboard moves the highlighted point: arrows one bucket, Page Up and Page Down seven (a
 * week of days), Home and End to the ends. Null for a key that is not a move, so the chart leaves
 * it to the browser. With nothing highlighted yet, any move starts at the newest point, the one
 * people look at first.
 */
export function moveIndex(key: string, index: number | null, length: number): number | null {
  if (length === 0) return null;
  const last = length - 1;
  if (index === null) return ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(key) ? (key === 'Home' ? 0 : last) : null;
  const clamp = (i: number) => Math.min(last, Math.max(0, i));
  switch (key) {
    case 'ArrowLeft':
    case 'ArrowDown':
      return clamp(index - 1);
    case 'ArrowRight':
    case 'ArrowUp':
      return clamp(index + 1);
    case 'PageUp':
      return clamp(index - 7);
    case 'PageDown':
      return clamp(index + 7);
    case 'Home':
      return 0;
    case 'End':
      return last;
    default:
      return null;
  }
}

/** The bucket nearest a horizontal position, for the pointer: buckets are evenly spaced from `start` by `step` */
export function nearestIndex(x: number, start: number, step: number, length: number): number {
  if (length <= 1 || step <= 0) return 0;
  return Math.min(length - 1, Math.max(0, Math.round((x - start) / step)));
}

/** A brushed range as two bucket indexes in order; null when it covers fewer than two buckets, which is a click, not a zoom */
export function brushRange(a: number, b: number, length: number): [number, number] | null {
  const lo = Math.max(0, Math.min(a, b));
  const hi = Math.min(length - 1, Math.max(a, b));
  return hi - lo >= 1 ? [lo, hi] : null;
}

/** The series and buckets cut to a zoomed range, both ends included */
export function sliceRange<T extends { values: Array<number | null>; comparison?: Array<number | null> }>(items: readonly T[], range: readonly [number, number] | null): T[] {
  if (!range) return [...items];
  const [lo, hi] = range;
  return items.map((s) => ({ ...s, values: s.values.slice(lo, hi + 1), ...(s.comparison && { comparison: s.comparison.slice(lo, hi + 1) }) }));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A bucket's day in words, in UTC like the buckets: `Oct 12`, or `Oct 12, 2025` when asked for the year */
export function dayLabel(day: string, withYear = false): string {
  const [y, m, d] = day.split('-');
  const month = MONTHS[Number(m) - 1] ?? m;
  return `${month} ${Number(d)}${withYear ? `, ${y}` : ''}`;
}

/** What a bucket is called in a tooltip or the table */
export function bucketLabel(bucket: string, unit: 'day' | 'week'): string {
  return unit === 'week' ? `Week of ${dayLabel(bucket)}` : dayLabel(bucket, false);
}

/** A count in few characters for an axis: 950, 1.2k, 34k, 1.5M */
export function compact(value: number): string {
  const abs = Math.abs(value);
  if (abs < 1000) return Number.isInteger(value) ? String(value) : value.toFixed(1);
  if (abs < 1_000_000) return `${trim(value / 1000)}k`;
  return `${trim(value / 1_000_000)}M`;
}

const trim = (n: number) => (Math.abs(n) >= 10 ? Math.round(n).toString() : n.toFixed(1).replace(/\.0$/, ''));

/** A count in full, with thousands separators, as tooltips and tables show it */
export const full = (value: number) => (Number.isInteger(value) ? value.toLocaleString('en') : value.toFixed(2));

/**
 * The relative change in words and sign, for a KPI's delta: `+12%`, `−3%`, `new` from zero, `—` when
 * both are zero. The minus is the real one, so a screen reader says "minus".
 */
export function deltaLabel(current: number, previous: number): { text: string; direction: 'up' | 'down' | 'flat' } {
  if (current === previous) return { text: previous === 0 ? '—' : '0%', direction: 'flat' };
  if (previous === 0) return { text: 'new', direction: 'up' };
  const pct = ((current - previous) / previous) * 100;
  const rounded = Math.abs(pct) >= 10 ? Math.round(pct) : Math.round(pct * 10) / 10;
  return { text: `${rounded > 0 ? '+' : '−'}${Math.abs(rounded)}%`, direction: rounded > 0 ? 'up' : rounded < 0 ? 'down' : 'flat' };
}

/** Which tick labels fit: every nth bucket, so labels about `minGap` px apart never collide */
export function tickEvery(length: number, width: number, minGap = 64): number {
  if (length <= 1 || width <= 0) return 1;
  return Math.max(1, Math.ceil(length / Math.max(1, Math.floor(width / minGap))));
}

const csvCell = (value: string | number | null) => {
  if (value === null) return '';
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/** The chart as CSV: a row per bucket, a column per series, and the comparison's columns after them */
export function seriesCsv(buckets: readonly string[], series: readonly ChartSeries[]): string {
  const withComparison = series.filter((s) => s.comparison);
  const head = ['bucket', ...series.map((s) => s.label), ...withComparison.map((s) => `${s.label} (previous period)`)];
  const rows = buckets.map((bucket, i) => [bucket, ...series.map((s) => s.values[i] ?? null), ...withComparison.map((s) => s.comparison?.[i] ?? null)]);
  return [head, ...rows].map((row) => row.map(csvCell).join(',')).join('\n') + '\n';
}
