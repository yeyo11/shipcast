import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useMemo } from 'react';
import { dayLabel, overlayComparison, seriesCsv, type ChartSeries } from '../../components/charts/data';
import { assignColours } from '../../components/charts/palette';
import { TimeChart } from '../../components/charts/TimeChart';
import { OnboardMeasure } from '../../components/illustrations';
import { Empty, PageHead } from '../../components/PageHead';
import { ControlBar, METRIC_NAMES } from '../../components/stats/ControlBar';
import { Growth } from '../../components/stats/Growth';
import { Kpis } from '../../components/stats/Kpis';
import { RankingTable } from '../../components/stats/RankingTable';
import { getGrowth, getStats } from '../../server/stats.functions';
import { compactSearch, readStatsSearch, withDefaults, type StatsSearch } from '../../server/stats-search';

/*
 * Stats: how the launches did across channels and accounts over time (milestone 5 of
 * docs/plans/goal-after-mvp.md, built on docs/decisions/app-design-direction.md and
 * docs/decisions/charts.md). The view lives in the address, so a period, a metric and a set of
 * filters can be shared as a link. The numbers come from the engine's stats queries (docs/stats.md).
 */

export const Route = createFileRoute('/_app/stats')({
  validateSearch: (search: Record<string, unknown>): Partial<StatsSearch> => readStatsSearch(search),
  loaderDeps: ({ search }) => ({ search }),
  loader: async ({ deps }) => {
    const stats = await getStats({ data: withDefaults(deps.search) });
    const growth = await getGrowth({ data: { from: stats.period.from, to: stats.period.to } });
    return { stats, growth };
  },
  head: () => ({ meta: [{ title: 'Stats · Shipcast' }] }),
  pendingComponent: Loading,
  component: Stats,
});

function Loading() {
  return (
    <>
      <PageHead title="Stats">How every launch did, channel by channel, over time.</PageHead>
      <div className="stats-loading" role="status">
        <OnboardMeasure width={200} />
        <p className="muted">Counting the numbers…</p>
      </div>
    </>
  );
}

function Stats() {
  const { stats, growth } = Route.useLoaderData();
  const search = withDefaults(Route.useSearch());
  const navigate = useNavigate({ from: Route.fullPath });
  const change = (patch: Partial<StatsSearch>) => {
    // A new view starts the ranking on its first page, unless the change is the page itself
    const next = withDefaults({ ...search, page: undefined, ...patch } as Partial<StatsSearch>);
    void navigate({ search: compactSearch(next), replace: false, resetScroll: false });
  };

  const { buckets, groups } = stats.chart;
  const series: ChartSeries[] = useMemo(() => {
    const colours = assignColours(groups.map((g) => ({ key: g.key, channel: g.channel, ...(g.id !== null && { id: g.id }) })));
    return groups.map((g) => ({
      key: g.key,
      label: g.label,
      colour: colours.get(g.key) ?? 'var(--sc-muted)',
      values: g.values,
      ...(g.comparison && { comparison: overlayComparison(buckets.length, g.comparison) }),
    }));
  }, [groups, buckets.length]);

  const metricName = METRIC_NAMES[search.metric];
  const per = stats.period.bucket === 'week' ? 'week' : 'day';
  const by = search.groupBy;
  const title = `${metricName} per ${per}, by ${by}`;
  const nothing = Object.values(stats.totals.metrics).every((v) => !v) && stats.ranking.total === 0;
  const filtered = Boolean(search.channels || search.accounts);
  const range = `${dayLabel(stats.period.from, true)} – ${dayLabel(stats.period.to, true)}`;

  const exportCsv = () => {
    const blob = new Blob([seriesCsv(buckets, series)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `shipcast-${search.metric}-by-${by}-${stats.period.from}-${stats.period.to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <PageHead
        title="Stats"
        action={
          <button type="button" className="btn btn-primary" onClick={exportCsv} disabled={series.length === 0}>
            Export CSV
          </button>
        }
      >
        How every launch did, channel by channel, over time.
      </PageHead>
      <ControlBar
        search={search}
        period={stats.period}
        options={stats.options}
        onChange={change}
      />
      <p className="stats-range muted" aria-live="polite">
        {range}
        {stats.comparePeriod && ` · compared with ${dayLabel(stats.comparePeriod.from, true)} – ${dayLabel(stats.comparePeriod.to, true)}`}
      </p>
      {nothing ? (
        <Empty
          art={<OnboardMeasure width={260} />}
          title="No numbers here yet"
          action={
            filtered ? (
              <button type="button" className="btn" onClick={() => change({ channels: undefined, accounts: undefined })}>
                Clear the filters
              </button>
            ) : search.period !== '90d' ? (
              <button type="button" className="btn" onClick={() => change({ period: '90d', from: undefined, to: undefined })}>
                Show the last 90 days
              </button>
            ) : (
              <Link className="btn" to="/launch">
                Launch a repo
              </Link>
            )
          }
        >
          {filtered
            ? 'Nothing these channels or accounts published grew in this period.'
            : 'Numbers are read every few hours once a launch is out. Try a longer period, or launch something.'}
        </Empty>
      ) : (
        <>
          <Kpis totals={stats.totals.metrics} previous={stats.totals.previous} metric={search.metric} onPick={(metric) => change({ metric })} />
          <section className="chart-card" aria-labelledby="chart-title">
            <h2 id="chart-title" className="chart-title">
              {title}
            </h2>
            {series.length === 0 ? (
              <p className="muted">No {metricName.toLowerCase()} in this period: the sources picked do not count them, or nothing grew. Try another metric above.</p>
            ) : (
              <TimeChart title={title} buckets={buckets} unit={per} series={series} kind={search.chart} comparisonName="Previous period" />
            )}
            <p className="chart-note muted">Drag across the chart, or hold Shift with the arrow keys, to zoom in. Each point is what grew that {per}.</p>
          </section>
          <RankingTable
            by={search.rank}
            sort={search.sort}
            order={search.order}
            entries={stats.ranking.entries}
            page={stats.ranking.page}
            pages={stats.ranking.pages}
            total={stats.ranking.total}
            onChange={change}
          />
        </>
      )}
      <Growth data={growth} />
    </>
  );
}
