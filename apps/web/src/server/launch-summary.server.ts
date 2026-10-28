import { METRIC_FAMILIES, readTimezone, SITE_SOURCES, statsSeries, type Launch, type Registry } from '@shipcast/engine';
import { channelTotals, dailyViews, latestByPiece, launchTotals, postAccountNames, splitSeries, type CounterReading, type LaunchNumbers } from './launch-summary.ts';

/**
 * A launch's counters at their latest reading: each piece's latest number, read per piece so pieces
 * read at different times all count, plus the latest reading of each launch-wide source.
 */
async function readingsOf(registry: Registry, launch: Launch): Promise<CounterReading[]> {
  const [site, history, posts] = await Promise.all([registry.metrics.latestMetrics(launch.id), registry.metrics.postMetricHistory(launch.id), registry.posts.posts(launch.id)]);
  const channel = new Map(posts.map((p) => [p.id, p.channel as string]));
  const pieces = latestByPiece(history).flatMap((r) => {
    const source = channel.get(r.postId);
    return source ? [{ source, name: r.name, value: r.value }] : [];
  });
  return [...site.filter((m) => (SITE_SOURCES as readonly string[]).includes(m.source)), ...pieces];
}

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Views per day for several launches and each of their channels in one query: the stats section's
 * daily series keyed by launch and channel, from the oldest launch's day (at most 399 days back, the
 * series' limit) to today. A failure to read it leaves the charts empty rather than the page broken.
 */
async function seriesOf(registry: Registry, launches: readonly Launch[]): Promise<ReturnType<typeof splitSeries>> {
  const empty: ReturnType<typeof splitSeries> = { launches: new Map(), channels: new Map() };
  if (launches.length === 0) return empty;
  const floor = new Date(Date.now() - 399 * 86_400_000).toISOString().slice(0, 10);
  const oldest = launches.map((l) => l.createdAt.slice(0, 10)).sort()[0] ?? today();
  try {
    const series = await statsSeries(registry, {
      metric: 'views',
      groupBy: 'launchChannel',
      bucket: 'day',
      from: oldest < floor ? floor : oldest,
      to: today(),
      launches: launches.map((l) => l.id),
      // Every launch's every channel one by one: nothing folds into "other"
      limit: Number.MAX_SAFE_INTEGER,
    });
    return splitSeries(series.groups);
  } catch {
    // An empty chart says "no views read yet", which is the truth the page can still tell
    return empty;
  }
}

/** The totals and the views per day of each launch and of each of its channels, for the list's cards and a launch's page */
export async function launchNumbers(registry: Registry, launches: readonly Launch[]): Promise<Map<number, LaunchNumbers>> {
  const [readings, series] = await Promise.all([Promise.all(launches.map((l) => readingsOf(registry, l))), seriesOf(registry, launches)]);
  return new Map(
    launches.map((l, i) => {
      const mine = readings[i] ?? [];
      const perChannel = channelTotals(mine, METRIC_FAMILIES);
      const days = series.channels.get(l.id) ?? new Map<string, ReadonlyArray<{ bucket: string; increase: number }>>();
      const names = new Set([...Object.keys(perChannel), ...days.keys()]);
      const channels = Object.fromEntries(
        [...names].map((name) => [name, { totals: perChannel[name] ?? {}, daily: dailyViews(days.get(name) ?? [], l.createdAt) }]),
      );
      return [l.id, { totals: launchTotals(mine, METRIC_FAMILIES), daily: dailyViews(series.launches.get(l.id) ?? [], l.createdAt), channels }];
    }),
  );
}

/**
 * The account each post of each launch went out with, as the brand's handle: a card marks a channel
 * published on more than one account and tells its posts apart by it. One read of the accounts for
 * every launch.
 */
export async function postAccounts(registry: Registry, launches: readonly Launch[]): Promise<Map<number, Record<number, string>>> {
  const accounts = new Map((await registry.accounts.accounts()).map((a) => [a.id, a.identity ?? a.label]));
  const posts = await Promise.all(launches.map((l) => registry.posts.posts(l.id)));
  return new Map(launches.map((l, i) => [l.id, postAccountNames(posts[i] ?? [], accounts)]));
}

/** What a launch's page says in its quiet line, besides what is scheduled: the comments still to answer */
export async function waitingComments(registry: Registry, launchId: number): Promise<number> {
  const comments = await registry.comments({ launchId, own: false, limit: 200 });
  return comments.filter((c) => c.status === 'new' || c.status === 'draft-ready' || c.status === 'failed').length;
}

export { readTimezone };
