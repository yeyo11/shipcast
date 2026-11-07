import { METRIC_FAMILIES, readTimezone, SITE_SOURCES, statsSeries, type Launch, type Repositories } from '@shipcast/engine';
import { FORMAT_SOURCES, formatPiece, readsMetrics, UTM_CHANNELS } from '@shipcast/schema';
import { launchUpdated, type AgedReading } from './launch-freshness.ts';
import { channelSiteVisits, channelTotals, dailyViews, latestByPiece, launchTotals, launchViewSources, newestRead, postAccountNames, splitSeries, totalAges, type CounterReading, type LaunchNumbers } from './launch-summary.ts';

/** Each tagged channel's `utm_source`, which names its visits in Umami's readings */
export const UTM_SOURCES: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(UTM_CHANNELS).map(([channel, tags]) => [channel, tags.source]));

/**
 * A launch's counters at their latest reading: each piece's latest number, read per piece so pieces
 * read at different times all count, plus the latest reading of each launch-wide source.
 */
async function readingsOf(registry: Pick<Repositories, 'posts' | 'metrics'>, launch: Launch): Promise<{ counters: CounterReading[]; umami: CounterReading[]; aged: AgedReading[] }> {
  const [site, history, posts] = await Promise.all([registry.metrics.latestMetrics(launch.id), registry.metrics.postMetricHistory(launch.id), registry.posts.posts(launch.id)]);
  const byId = new Map(posts.map((p) => [p.id, p]));
  const now = new Date();
  // When the launch went out, for its site sources' age: its first piece out, or its creation
  const out = posts.reduce((first, p) => (p.publishedAt < first ? p.publishedAt : first), launch.createdAt);
  const pieces = latestByPiece(history).flatMap((r) => {
    const post = byId.get(r.postId);
    return post ? [{ source: post.channel as string, name: r.name, value: r.value, checkedAt: r.checkedAt, post }] : [];
  });
  const siteReadings = site.filter((m) => (SITE_SOURCES as readonly string[]).includes(m.source));
  // What can be overdue: the site's readings and the pieces still read (not deleted, not a story past its hours)
  const aged: AgedReading[] = [
    ...[...siteReadings, ...site.filter((m) => m.source === 'umami')].map((m) => ({ source: m.source, name: m.name, value: m.value, checkedAt: m.checkedAt, publishedAt: out })),
    ...pieces
      .filter(({ post }) => post.status !== 'deleted' && readsMetrics(post.channel, post.kind, { publishedAt: post.publishedAt, now }))
      .map(({ post, ...r }) => ({ ...r, publishedAt: post.publishedAt })),
  ];
  return { counters: [...siteReadings, ...pieces.map(({ post: _post, ...r }) => r)], umami: site.filter((m) => m.source === 'umami'), aged };
}

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Views per day for several launches and each of their channels in one query: the stats section's
 * daily series keyed by launch and channel, from the oldest launch's day (at most 399 days back, the
 * series' limit) to today. A failure to read it leaves the charts empty rather than the page broken.
 *
 * Only the sources the launch's views total counts: the stats' views family also takes the repo's
 * traffic from its days, which the total leaves out, so a release's (or the launches repo's, for an
 * article) busiest day of repo views stood above the launch's whole total (launch 1: 98 a day, 79 in all).
 */
async function seriesOf(registry: Pick<Repositories, 'posts' | 'metrics' | 'accounts' | 'comments' | 'queries'>, launches: readonly Launch[]): Promise<ReturnType<typeof splitSeries>> {
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
      channels: launchViewSources(METRIC_FAMILIES),
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
export async function launchNumbers(registry: Pick<Repositories, 'posts' | 'metrics' | 'accounts' | 'comments' | 'queries'>, launches: readonly Launch[]): Promise<Map<number, LaunchNumbers>> {
  const [readings, series] = await Promise.all([Promise.all(launches.map((l) => readingsOf(registry, l))), seriesOf(registry, launches)]);
  return new Map(
    launches.map((l, i) => {
      const mine = readings[i]?.counters ?? [];
      const perChannel = channelTotals(mine, METRIC_FAMILIES);
      const site = channelSiteVisits(readings[i]?.umami ?? [], UTM_SOURCES, { sources: FORMAT_SOURCES, piece: formatPiece });
      const days = series.channels.get(l.id) ?? new Map<string, ReadonlyArray<{ bucket: string; increase: number }>>();
      const names = new Set([...Object.keys(perChannel), ...days.keys(), ...Object.keys(site)]);
      const channels = Object.fromEntries(
        [...names].map((name) => [
          name,
          { totals: perChannel[name] ?? {}, ages: totalAges(mine.filter((r) => r.source === name), METRIC_FAMILIES), daily: dailyViews(days.get(name) ?? [], l.createdAt), ...(site[name] && { site: site[name] }) },
        ]),
      );
      const ages = totalAges(mine, METRIC_FAMILIES);
      // The newest read among the totals' sources; overdue from every source the launch is still read from
      const fresh = launchUpdated(readings[i]?.aged ?? []);
      const readAt = newestRead(ages);
      const updated = readAt ? { readAt, overdue: fresh?.overdue ?? [] } : undefined;
      return [l.id, { totals: launchTotals(mine, METRIC_FAMILIES), ages, ...(updated && { updated }), daily: dailyViews(series.launches.get(l.id) ?? [], l.createdAt), channels }];
    }),
  );
}

/**
 * The account each post of each launch went out with, as the brand's handle: a card marks a channel
 * published on more than one account and tells its posts apart by it. One read of the accounts for
 * every launch.
 */
export async function postAccounts(registry: Pick<Repositories, 'posts' | 'accounts'>, launches: readonly Launch[]): Promise<Map<number, Record<number, string>>> {
  const accounts = new Map((await registry.accounts.accounts()).map((a) => [a.id, a.identity ?? a.label]));
  const posts = await Promise.all(launches.map((l) => registry.posts.posts(l.id)));
  return new Map(launches.map((l, i) => [l.id, postAccountNames(posts[i] ?? [], accounts)]));
}

/** What a launch's page says in its quiet line, besides what is scheduled: the comments still to answer */
export async function waitingComments(registry: Pick<Repositories, 'comments'>, launchId: number): Promise<number> {
  const comments = await registry.comments.comments({ launchId, own: false, limit: 200 });
  return comments.filter((c) => c.status === 'new' || c.status === 'draft-ready' || c.status === 'failed').length;
}

export { readTimezone };
