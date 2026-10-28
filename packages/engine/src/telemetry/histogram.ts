/**
 * A latency histogram of fixed, geometric buckets: bucket `i` holds the durations above 1.25^(i-1) ms
 * and up to 1.25^i ms, so each bucket is 25 % wider than the one before and a percentile read from
 * them is within 25 % of the true value. Fixed buckets add up: two processes' hours, or 24 hours of
 * one, merge by adding counts, which stored percentiles would not.
 */
export type Histogram = Record<string, number>;

const GROWTH = 1.25;
/** 1.25^80 ms is about 15 days: nothing measured here lasts longer */
const LAST = 80;

/** The bucket a duration falls in */
export function bucketOf(ms: number): number {
  if (!(ms > 1)) return 0;
  return Math.min(LAST, Math.ceil(Math.log(ms) / Math.log(GROWTH)));
}

/** The upper bound of a bucket, in milliseconds */
export function bucketBound(bucket: number): number {
  return GROWTH ** bucket;
}

/** Adds one duration to a histogram, in place */
export function observe(histogram: Histogram, ms: number): void {
  const key = String(bucketOf(ms));
  histogram[key] = (histogram[key] ?? 0) + 1;
}

/** The sum of several histograms, as a new one */
export function merge(...histograms: Histogram[]): Histogram {
  const out: Histogram = {};
  for (const h of histograms) for (const [key, count] of Object.entries(h)) out[key] = (out[key] ?? 0) + count;
  return out;
}

/**
 * The duration under which a share `q` (0 to 1) of the observations fall, as the upper bound of the
 * bucket that reaches it: an estimate that never understates. Undefined for an empty histogram.
 */
export function percentile(histogram: Histogram, q: number): number | undefined {
  const buckets = Object.entries(histogram)
    .map(([key, count]) => [Number(key), count] as const)
    .filter(([, count]) => count > 0)
    .sort((a, b) => a[0] - b[0]);
  const total = buckets.reduce((sum, [, count]) => sum + count, 0);
  if (total === 0) return undefined;
  const rank = Math.max(1, Math.ceil(q * total));
  let seen = 0;
  for (const [bucket, count] of buckets) {
    seen += count;
    if (seen >= rank) return bucketBound(bucket);
  }
  return bucketBound(buckets[buckets.length - 1]![0]);
}
