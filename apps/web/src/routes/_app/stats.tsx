import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { overlayComparison, seriesCsv, type ChartSeries } from '../../components/charts/data';
import { assignColours } from '../../components/charts/palette';
import { TrendChart } from '../../components/charts/TrendChart';
import { Scale } from '../../components/illustrations';
import { TopBar } from '../../components/kit/Bars';
import { Icon } from '../../components/kit/Icon';
import { useLiveEnabled, useLiveRoute } from '../../components/live/Live';
import { Accounts } from '../../components/stats/Accounts';
import { Details } from '../../components/stats/Details';
import { summarize } from '../../components/stats/filter-options';
import { Filters } from '../../components/stats/Filters';
import { Kpis } from '../../components/stats/Kpis';
import { METRIC_NAMES, PERIOD_CHIPS, periodChip, periodWords, StatsEmpty } from '../../components/stats/parts';
import { Ranking, Top } from '../../components/stats/Ranking';
import { Search } from '../../components/stats/Search';
import { getGrowth, getSearch, getStats } from '../../server/stats.functions';
import { compactSearch, readStatsSearch, readStatsTab, withDefaults, type GroupBy, type StatsSearch, type StatsTab } from '../../server/stats-search';

/*
 * Stats (boards StatsOverview, StatsRanking, StatsAccounts, StatsSearch, StatsEmpty, StatsFilters and
 * DesktopStats): how the launches did across channels and accounts over time, one tab each for the
 * overview, the ranking, the accounts and search. The view lives in the address, the tab included,
 * so a period, a metric, a set of filters and a tab can be shared as a link. The numbers come from
 * the engine's stats queries (docs/stats.md).
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
  head: () => ({ meta: [{ title: 'Stats · Shipcast' }] }),
  pendingComponent: Loading,
  component: Stats,
});

const TAB_NAMES: Record<StatsTab, string> = { overview: 'Overview', ranking: 'Ranking', accounts: 'Accounts', search: 'Search' };
const TABS = Object.keys(TAB_NAMES) as StatsTab[];
/** The chart's groupings the board offers; by account stays reachable through the address */
const GROUPS: Array<{ value: GroupBy; label: string }> = [
  { value: 'total', label: 'Total' },
  { value: 'channel', label: 'Channel' },
  { value: 'launch', label: 'Launch' },
];

function Loading() {
  return (
    <div className="stats">
      <TopBar />
      <div className="stats-page" role="status" aria-label="Counting the numbers">
        <div className="k-px stats-head">
          <h1 className="k-d stats-title">Stats</h1>
        </div>
        <div className="k-px stats-gap14 stats-kpis">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="k-skel stats-skel-kpi" />
          ))}
        </div>
        <div className="k-px stats-gap14">
          <div className="k-skel stats-skel-chart" />
        </div>
      </div>
    </div>
  );
}

function Stats() {
  const { stats, growth, search: searchData } = Route.useLoaderData();
  // Live (realtime-ui): a metrics run, an account's numbers or a new piece reloads the figures
  useLiveRoute(Route.id, useLiveEnabled() ? ['metrics', 'account', 'post'] : null);
  const { tab = 'overview', ...address } = Route.useSearch();
  const search = withDefaults(address);
  const navigate = useNavigate({ from: Route.fullPath });
  const [filtersOpen, setFiltersOpen] = useState(false);
  const change = (patch: Partial<StatsSearch>) => {
    // A new view starts the ranking on its first page, unless the change is the page itself
    const next = withDefaults({ ...search, page: undefined, ...patch } as Partial<StatsSearch>);
    void navigate({ search: { ...compactSearch(next), ...(tab !== 'overview' && { tab }) }, replace: false, resetScroll: false });
  };
  // The tab replaces the entry rather than adding one: Back leaves the page instead of walking the tabs
  const pickTab = (next: StatsTab) => void navigate({ search: { ...compactSearch(search), ...(next !== 'overview' && { tab: next }) }, replace: true, resetScroll: false });
  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = TABS[(index + step + TABS.length) % TABS.length] ?? 'overview';
    pickTab(next);
    document.getElementById(`stats-tab-${next}`)?.focus();
  };

  const { buckets, groups } = stats.chart;
  const series: ChartSeries[] = useMemo(() => {
    const colours = assignColours(groups.map((g) => ({ key: g.key, channel: g.channel, ...(g.id !== null && { id: g.id }) })));
    return groups.map((g) => ({
      key: g.key,
      label: g.label,
      colour: g.key === 'total' ? 'var(--sc-yellow)' : (colours.get(g.key) ?? 'var(--sc-muted)'),
      values: g.values,
      ...(g.comparison && { comparison: overlayComparison(buckets.length, g.comparison) }),
    }));
  }, [groups, buckets.length]);

  const metricName = METRIC_NAMES[search.metric];
  const per = stats.period.bucket === 'week' ? 'week' : 'day';
  const chartTitle = `${metricName} per ${per}`;
  const nothing = Object.values(stats.totals.metrics).every((v) => !v) && stats.ranking.total === 0;
  const filtered = Boolean(search.channels || search.accounts || search.launches);
  const words = periodWords(search.period, stats.period.from, stats.period.to);
  const chip = periodChip(search.period, stats.period.from, stats.period.to);
  const channelsChip = summarize(search.channels ?? [], stats.options.channels, 'channels') ?? 'All channels';
  const best = stats.best;
  // The bucket the best launch went out in: the last one starting on or before its day
  const markIndex = best?.publishedOn ? buckets.reduce((at, b, i) => (b <= (best.publishedOn ?? '') ? i : at), -1) : -1;
  const position = stats.averages.find((a) => a.source === 'search' && a.metric === 'position')?.value ?? null;

  const exportCsv = () => {
    const blob = new Blob([seriesCsv(buckets, series)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `shipcast-${search.metric}-by-${search.groupBy}-${stats.period.from}-${stats.period.to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const periodChips = (
    <>
      {PERIOD_CHIPS.map((p) => (
        <button key={p.value} type="button" className={`k-chip${search.period === p.value ? ' k-pick' : ''}`} aria-pressed={search.period === p.value} onClick={() => change({ period: p.value, from: undefined, to: undefined })}>
          {p.label}
        </button>
      ))}
    </>
  );
  // On a phone the ranking and search say the view in three chips, each opening the filters
  const filterChips = (
    <div className="k-phone">
      <div className="k-px k-hrow k-g8 stats-gap14 stats-chips">
        <button type="button" className={`k-chip${search.period === 'custom' ? ' k-pick' : ''}`} onClick={() => setFiltersOpen(true)} aria-label={`Period: ${words}. Change the filters`}>
          <Icon name="calendar" size={16} />
          {chip}
        </button>
        <button type="button" className={`k-chip${search.channels ? ' k-on' : ''}`} onClick={() => setFiltersOpen(true)} aria-label={`Channels: ${channelsChip}. Change the filters`}>
          <span className="k-ellipsis">{channelsChip}</span> <Icon name="chevronDown" size={16} />
        </button>
        <button type="button" className={`k-chip${filtered ? ' k-on' : ''}`} onClick={() => setFiltersOpen(true)}>
          <Icon name="filter" size={16} />
          Filters
        </button>
      </div>
    </div>
  );

  const empty = (
    <StatsEmpty
      art={<Scale width={240} />}
      title="No numbers here yet"
      actions={
        filtered ? (
          <button type="button" className="k-btn" onClick={() => change({ channels: undefined, accounts: undefined, launches: undefined })}>
            Clear the filters
          </button>
        ) : (
          <>
            {search.period !== 'all' && (
              <button type="button" className="k-btn" onClick={() => change({ period: 'all', from: undefined, to: undefined })}>
                All time
              </button>
            )}
            <Link className="k-btn" to="/launch">
              <Icon name="plus" size={18} />
              Launch a repo
            </Link>
          </>
        )
      }
    >
      {filtered ? 'Nothing these channels, accounts or launches published grew in this period.' : 'Numbers are read every few hours once a launch is out. Try a longer period, or launch something.'}
    </StatsEmpty>
  );

  const groupChips = (
    <div className="k-hrow k-g8 k-wrap k-xs k-muted stats-groupby" role="radiogroup" aria-label="Group the chart by">
      <span aria-hidden="true">Group by</span>
      {GROUPS.map((g) => (
        <button key={g.value} type="button" role="radio" aria-checked={search.groupBy === g.value} className={`k-chip stats-groupby-chip${search.groupBy === g.value ? ' k-on' : ''}`} onClick={() => change({ groupBy: g.value })}>
          {g.label}
        </button>
      ))}
    </div>
  );

  const overview = nothing ? (
    empty
  ) : (
    <>
      <div className="k-phone">
        <div className="k-px k-hrow k-wrap stats-gap14 stats-period-row">
          {periodChips}
          {/* The board's row has room for one more: the way to a custom range and the channels on a phone */}
          <button type="button" className={`k-chip stats-filter-icon${filtered || search.period === 'custom' ? ' k-pick' : ''}`} aria-label={filtered || search.period === 'custom' ? `Filters: ${chip}, ${channelsChip}` : 'Filters'} onClick={() => setFiltersOpen(true)}>
            <Icon name="filter" size={16} />
          </button>
        </div>
      </div>
      <div className="k-px stats-gap14">
        <Kpis totals={stats.totals.metrics} previous={stats.totals.previous} days={stats.period.days} metric={search.metric} onPick={(metric) => change({ metric })} />
      </div>
      <div className="stats-grid stats-gap14">
        <div className="k-px">
          <section className="k-card stats-chart-card" aria-labelledby="stats-chart-title">
            <div className="k-hrow k-between k-g8">
              <strong id="stats-chart-title" className="stats-chart-title">
                {chartTitle}
              </strong>
              <span className="k-xs k-muted stats-only-phone">{words}</span>
              <div className="stats-only-desktop">{groupChips}</div>
            </div>
            {series.length === 0 ? (
              <p className="k-sm k-muted stats-chart-none">No {metricName.toLowerCase()} in this period: the sources picked do not count them, or nothing grew. Pick another number above.</p>
            ) : (
              <TrendChart title={chartTitle} buckets={buckets} unit={per} series={series} noun={metricName.toLowerCase()} mark={best && markIndex >= 0 ? { index: markIndex, label: `${best.title} out` } : null} />
            )}
            <div className="stats-only-phone">{groupChips}</div>
          </section>
        </div>
        <div className="k-desktop">
          <Top entries={stats.top} onAll={() => pickTab('ranking')} />
        </div>
      </div>
      {best && (
        <div className="k-phone">
          <div className="k-px stats-gap14">
            <Link className="k-card stats-best" to="/launches/$id" params={{ id: String(best.launchId) }}>
              <span className="k-lbl">Best launch this period</span>
              <div className="k-hrow k-between k-g8">
                <span className="k-hrow k-g8 stats-best-name">
                  <span className="k-d k-d30 k-ellipsis">{best.name}</span>
                  {best.ref && <span className="k-mono k-xs k-muted">{best.ref}</span>}
                </span>
                <span className="k-sm k-hrow k-g4 stats-best-value">
                  {best.value.toLocaleString('en')} {metricName.toLowerCase()}
                  <Icon name="chevronRight" size={16} />
                </span>
              </div>
            </Link>
          </div>
        </div>
      )}
      <div className="k-px stats-gap14">
        <Details details={stats.details} averages={stats.averages} />
      </div>
    </>
  );

  const panels: Record<StatsTab, ReactNode> = {
    overview,
    ranking: nothing ? (
      empty
    ) : (
      <>
        {filterChips}
        <Ranking by={search.rank} entries={stats.ranking.entries} page={stats.ranking.page} pages={stats.ranking.pages} onChange={change} />
      </>
    ),
    accounts: <Accounts data={growth} days={stats.period.days} />,
    search: (
      <>
        {filterChips}
        <Search data={searchData} period={words} position={position} />
      </>
    ),
  };

  return (
    <div className="stats">
      <TopBar />
      <div className="stats-page">
        <div className="k-px stats-head">
          <div className="k-stack k-g12">
            <h1 className="k-d stats-title">Stats</h1>
            <p className="k-lead k-muted stats-lead">How every launch did, channel by channel, over time.</p>
          </div>
          <div className="k-hrow k-g8 stats-tools">
            <div className="stats-only-desktop">
              <div className="k-hrow k-g8">
                {periodChips}
                <button type="button" className={`k-chip${search.period === 'custom' ? ' k-pick' : ''}`} onClick={() => setFiltersOpen(true)}>
                  <Icon name="calendar" size={16} />
                  {search.period === 'custom' ? chip : 'Custom'}
                </button>
                <button type="button" className={`k-chip${filtered ? ' k-on' : ''}`} onClick={() => setFiltersOpen(true)} aria-label={`Channels: ${channelsChip}. Change the filters`}>
                  {channelsChip} <Icon name="chevronDown" size={16} />
                </button>
              </div>
            </div>
            <button type="button" className="k-btn k-icon k-sm" aria-label="Export CSV" title="Export CSV" onClick={exportCsv} disabled={series.length === 0}>
              <Icon name="download" />
            </button>
          </div>
        </div>
        <div className="stats-tabs-wrap">
          <div role="tablist" aria-label="Stats sections" className="k-tabs stats-tabs">
            {TABS.map((t, i) => (
              <button
                key={t}
                id={`stats-tab-${t}`}
                type="button"
                role="tab"
                aria-selected={tab === t}
                aria-controls="stats-panel"
                tabIndex={tab === t ? 0 : -1}
                className={`k-tab${tab === t ? ' k-on' : ''}`}
                onClick={() => pickTab(t)}
                onKeyDown={(e) => onTabKey(e, i)}
              >
                {TAB_NAMES[t]}
              </button>
            ))}
          </div>
        </div>
        <div id="stats-panel" role="tabpanel" aria-labelledby={`stats-tab-${tab}`} className="stats-panel">
          {panels[tab]}
        </div>
      </div>
      <Filters open={filtersOpen} onOpenChange={setFiltersOpen} search={search} period={stats.period} options={stats.options} onChange={change} />
    </div>
  );
}
