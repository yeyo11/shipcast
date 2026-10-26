import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useMemo, type ReactNode } from 'react';
import { dayLabel, overlayComparison, seriesCsv, type ChartSeries } from '../../components/charts/data';
import { assignColours } from '../../components/charts/palette';
import { TimeChart } from '../../components/charts/TimeChart';
import { OnboardMeasure } from '../../components/illustrations';
import { Empty, PageHead } from '../../components/PageHead';
import { Accounts } from '../../components/stats/Accounts';
import { FilterBar, METRIC_NAMES } from '../../components/stats/FilterBar';
import { Kpis } from '../../components/stats/Kpis';
import { RankingTable } from '../../components/stats/RankingTable';
import { Search } from '../../components/stats/Search';
import { DownloadIcon } from '../../components/ui/icons';
import { Tabs } from '../../components/ui/Tabs';
import { getGrowth, getSearch, getStats } from '../../server/stats.functions';
import { compactSearch, readStatsSearch, readStatsTab, withDefaults, type StatsSearch, type StatsTab } from '../../server/stats-search';
import statsCss from '../../styles/stats.css?url';

/*
 * Stats: how the launches did across channels and accounts over time (milestone 5 of
 * docs/plans/goal-after-mvp.md, built on docs/decisions/app-design-direction.md and
 * docs/decisions/charts.md). One screen per tab (Overview, Ranking, Accounts, Search) under one
 * filter bar, so nothing needs a long scroll. The view lives in the address, the tab included, so a
 * period, a metric, a set of filters and a tab can be shared as a link. The numbers come from the
 * engine's stats queries (docs/stats.md).
 */

type RouteSearch = Partial<StatsSearch> & { tab?: StatsTab };

export const Route = createFileRoute('/_app/stats')({
  validateSearch: (search: Record<string, unknown>): RouteSearch => {
    const tab = readStatsTab(search);
    return { ...readStatsSearch(search), ...(tab && { tab }) };
  },
  // The tab is left out: moving between tabs shows what is loaded, it does not count it again
  loaderDeps: ({ search: { tab: _tab, ...search } }) => ({ search }),
  loader: async ({ deps }) => {
    const stats = await getStats({ data: withDefaults(deps.search) });
    const range = { from: stats.period.from, to: stats.period.to };
    const [growth, search] = await Promise.all([getGrowth({ data: range }), getSearch({ data: { ...range, ...(deps.search.launches && { launches: deps.search.launches }) } })]);
    return { stats, growth, search };
  },
  // The charts' styles load with the section that draws them, not on every page of the app
  head: () => ({ meta: [{ title: 'Stats · Shipcast' }], links: [{ rel: 'stylesheet', href: statsCss }] }),
  pendingComponent: Loading,
  component: Stats,
});

const TAB_NAMES: Record<StatsTab, string> = { overview: 'Overview', ranking: 'Ranking', accounts: 'Accounts', search: 'Search' };

function Loading() {
  return (
    <div className="stats-page">
      <PageHead title="Stats">How every launch did, channel by channel, over time.</PageHead>
      <div className="stats-loading" role="status">
        <OnboardMeasure width={200} />
        <p className="muted">Counting the numbers…</p>
      </div>
    </div>
  );
}

function Stats() {
  const { stats, growth, search: searchData } = Route.useLoaderData();
  const { tab = 'overview', ...address } = Route.useSearch();
  const search = withDefaults(address);
  const navigate = useNavigate({ from: Route.fullPath });
  const change = (patch: Partial<StatsSearch>) => {
    // A new view starts the ranking on its first page, unless the change is the page itself
    const next = withDefaults({ ...search, page: undefined, ...patch } as Partial<StatsSearch>);
    void navigate({ search: { ...compactSearch(next), ...(tab !== 'overview' && { tab }) }, replace: false, resetScroll: false });
  };
  // The tab replaces the entry rather than adding one: Back leaves the page instead of walking the tabs
  const pickTab = (next: StatsTab) => void navigate({ search: { ...compactSearch(search), ...(next !== 'overview' && { tab: next }) }, replace: true, resetScroll: false });

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
  const filtered = Boolean(search.channels || search.accounts || search.launches);
  const range = `${dayLabel(stats.period.from, true)} – ${dayLabel(stats.period.to, true)}${
    stats.comparePeriod ? ` · compared with ${dayLabel(stats.comparePeriod.from, true)} – ${dayLabel(stats.comparePeriod.to, true)}` : ''
  }`;

  const exportCsv = () => {
    const blob = new Blob([seriesCsv(buckets, series)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `shipcast-${search.metric}-by-${by}-${stats.period.from}-${stats.period.to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const empty = (
    <Empty
      art={<OnboardMeasure width={220} />}
      title="No numbers here yet"
      action={
        filtered ? (
          <button type="button" className="btn" onClick={() => change({ channels: undefined, accounts: undefined, launches: undefined })}>
            Clear the filters
          </button>
        ) : search.period !== 'all' ? (
          <button type="button" className="btn" onClick={() => change({ period: 'all', from: undefined, to: undefined })}>
            Show all of it
          </button>
        ) : (
          <Link className="btn" to="/launch">
            Launch a repo
          </Link>
        )
      }
    >
      {filtered
        ? 'Nothing these channels, accounts or launches published grew in this period.'
        : 'Numbers are read every few hours once a launch is out. Try a longer period, or launch something.'}
    </Empty>
  );

  const overview = nothing ? (
    empty
  ) : (
    <>
      <Kpis totals={stats.totals.metrics} previous={stats.totals.previous} metric={search.metric} onPick={(metric) => change({ metric })} />
      <section className="chart-card" aria-labelledby="chart-title">
        <h2 id="chart-title" className="chart-title">
          {title}
        </h2>
        {series.length === 0 ? (
          <p className="muted">No {metricName.toLowerCase()} in this period: the sources picked do not count them, or nothing grew. Pick another number above.</p>
        ) : (
          <TimeChart title={title} buckets={buckets} unit={per} series={series} kind={search.chart} comparisonName="Previous period" height={280} />
        )}
        <p className="chart-note muted">Drag across the chart, or hold Shift with the arrow keys, to zoom in. Each point is what grew that {per}.</p>
      </section>
    </>
  );

  const ranking = nothing ? (
    empty
  ) : (
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
  );

  const panels: Record<StatsTab, ReactNode> = { overview, ranking, accounts: <Accounts data={growth} />, search: <Search data={searchData} /> };

  return (
    <div className="stats-page">
      <PageHead
        title="Stats"
        action={
          <>
            {/* One of the two shows (stats.css): the words on a desktop, the glyph beside the title on a phone */}
            <button type="button" className="btn btn-primary stats-export-text" onClick={exportCsv} disabled={series.length === 0}>
              Export CSV
            </button>
            <button type="button" className="ui-icon-button stats-export-icon" onClick={exportCsv} disabled={series.length === 0} aria-label="Export CSV">
              <DownloadIcon />
            </button>
          </>
        }
      >
        How every launch did, channel by channel, over time.
      </PageHead>
      <FilterBar search={search} period={stats.period} options={stats.options} onChange={change} range={range} />
      <Tabs<StatsTab>
        label="Stats sections"
        variant="underline"
        value={tab}
        onValueChange={pickTab}
        tabs={(Object.keys(TAB_NAMES) as StatsTab[]).map((t) => ({ value: t, label: TAB_NAMES[t], panel: panels[t] }))}
      />
    </div>
  );
}
