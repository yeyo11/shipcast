import { createFileRoute, Link, useRouter } from '@tanstack/react-router';
import { useEffect } from 'react';
import { EmptyLaunches } from '../../components/illustrations';
import { Icon } from '../../components/kit/Icon';
import { TopBar } from '../../components/kit/Bars';
import { badgeText, useShell } from '../../components/kit/shell';
import { LaunchCard, type HomeLaunch } from '../../components/LaunchCard';
import { FilterMenus, FilterSheet, LaunchPager, SearchBox, useLaunchesNavigate } from '../../components/LaunchFilters';
import { ApprovalCard, AttentionRow, attentionRows } from '../../components/LaunchRows';
import { useLiveEnabled, useLiveRoute } from '../../components/live/Live';
import { splitLaunches } from '../../server/launch-list';
import { readLaunchesSearch, type LaunchesSearch } from '../../server/launches-search';
import { listLaunches } from '../../server/launches.functions';
import { CHANNEL_NAMES } from '../../server/view';

/*
 * Launches, the home (boards Main, LaunchesEmpty and DesktopHome): what needs the owner first (the
 * yellow card of a launch waiting for approval, then a row for each other thing the bell counts),
 * then every launch, a page at a time, with the filters, the words and the order in the address and
 * applied by the database (docs/decisions/lists.md).
 */
export const Route = createFileRoute('/_app/')({
  head: () => ({ meta: [{ title: 'Launches · Shipcast' }] }),
  validateSearch: (search: Record<string, unknown>): LaunchesSearch => readLaunchesSearch(search),
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => listLaunches({ data: deps }),
  component: Launches,
});

const network = (channel: string) => CHANNEL_NAMES[channel] ?? channel;

function Head({ empty }: { empty: boolean }) {
  return (
    <div className="home-head">
      <div className="k-stack k-g12">
        <h1 className="k-d home-title">Launches</h1>
        <p className="k-lead k-muted k-desktop">Every release Shipcast noticed, where it went and how it did.</p>
      </div>
      {!empty && (
        <>
          <Link className="k-btn k-sm k-phone-flex" to="/launch">
            <Icon name="plus" size={18} />
            Launch
          </Link>
          <div className="k-hrow k-g10 k-desktop-flex">
            <Link className="k-btn" to="/write">
              <Icon name="write" size={18} />
              Write an article
            </Link>
            <Link className="k-btn" to="/launch">
              <Icon name="plus" size={18} />
              Launch a repo
            </Link>
          </div>
        </>
      )}
    </div>
  );
}

/** The first run (board LaunchesEmpty): the art, what Shipcast does, and the two ways to start */
function FirstRun() {
  return (
    <div className="k-stack k-g16 home-empty">
      <div className="home-empty-art" aria-hidden="true">
        <EmptyLaunches width={260} />
      </div>
      <h2 className="k-d k-d30">Nothing launched yet</h2>
      <p className="k-muted home-empty-text">Pick a release and Shipcast drafts the article and every post. Or write about anything, without a release.</p>
      <div className="k-stack k-g10 home-empty-actions">
        <Link className="k-btn k-pri k-full" to="/launch">
          <Icon name="launches" size={18} />
          Launch a repo
        </Link>
        <Link className="k-btn k-full" to="/write">
          <Icon name="write" size={18} />
          Write an article
        </Link>
      </div>
      <p className="k-xs k-muted home-empty-note">
        With a trigger rule, a new release launches itself. <Link to="/settings/automation">Automation</Link>
      </p>
    </div>
  );
}

function Launches() {
  const { launches, page, facets, timezone } = Route.useLoaderData();
  const search = Route.useSearch();
  const go = useLaunchesNavigate(search);
  const router = useRouter();
  const { attention } = useShell();
  const list = launches as HomeLaunch[];
  const busy = list.some((l) => l.status === 'generating' || l.status === 'detected');
  const lanes = splitLaunches(list);
  const rest = list.filter((l) => !lanes.approval.includes(l));
  // Every launch there is, whatever the filters: an empty registry is the first run, not a search with no match
  const any = facets.statuses.some((s) => s.count > 0);
  const narrowed = Object.keys(search).some((k) => k !== 'page' && k !== 'sort');
  const rows = attentionRows(attention?.items ?? []);
  const count = attention?.count ?? 0;
  // Live (realtime-ui): the list is read again when a launch, a piece or a launch's numbers change
  const live = useLiveEnabled();
  useLiveRoute(Route.id, live ? ['launch', 'post', 'metrics'] : null);
  // Otherwise, while something runs, the page follows it by polling
  useEffect(() => {
    if (live || !busy) return;
    const timer = setInterval(() => router.invalidate(), 5000);
    return () => clearInterval(timer);
  }, [live, busy, router]);

  const needs = lanes.approval.length > 0 || rows.length > 0;
  return (
    <div className="home">
      <TopBar />
      <div className="home-page">
        <Head empty={!any} />
        {!any ? (
          <FirstRun />
        ) : (
          <>
            {needs && (
              <section className={`home-needs${lanes.approval.length > 0 ? '' : ' home-needs-rows'}`} aria-labelledby="home-needs">
                <h2 id="home-needs" className="k-hrow k-g8 k-lbl home-needs-head k-phone-flex">
                  Waiting for you {count > 0 && <span className="k-badge">{badgeText(count)}</span>}
                </h2>
                {lanes.approval.length > 0 && (
                  <div className="k-stack k-g16 home-approvals">
                    {lanes.approval.map((l) => (
                      <ApprovalCard key={l.id} launch={l} />
                    ))}
                  </div>
                )}
                {rows.length > 0 && (
                  <div className="home-also">
                    <div className="k-hrow k-between k-desktop-flex">
                      <h2 className="k-d k-d30">{lanes.approval.length > 0 ? 'Also needs you' : 'Needs you'}</h2>
                      <span className="k-badge">{badgeText(rows.length)}</span>
                    </div>
                    <ul className="k-stack home-rows">
                      {rows.map((item) => (
                        <AttentionRow key={item.key} item={item} network={network} />
                      ))}
                    </ul>
                  </div>
                )}
              </section>
            )}
            <section className="home-all" aria-labelledby="home-all">
              <div className="home-all-head">
                <div className="k-hrow k-between home-all-title">
                  <h2 id="home-all" className="k-d">
                    All launches
                  </h2>
                  <span className="k-sm k-muted k-phone" aria-live="polite">
                    {page.total}
                  </span>
                </div>
                <div className="k-hrow k-g8 home-tools">
                  <SearchBox search={search} />
                  <div className="k-phone">
                    <FilterSheet search={search} facets={facets} total={page.total} />
                  </div>
                  <div className="k-hrow k-g8 k-desktop-flex">
                    <FilterMenus search={search} facets={facets} />
                  </div>
                </div>
              </div>
              {rest.length === 0 ? (
                <div className="k-stack k-g12 home-nomatch">
                  <p className="k-muted">{narrowed ? 'No launch matches these filters.' : lanes.approval.length > 0 ? 'Nothing else yet.' : 'No launches on this page.'}</p>
                  {narrowed && (
                    <button type="button" className="k-btn k-sm" onClick={() => go({ q: undefined, status: undefined, trigger: undefined, kind: undefined, repo: undefined })}>
                      Show every launch
                    </button>
                  )}
                </div>
              ) : (
                <div className="home-grid">
                  {rest.map((l) => (
                    <LaunchCard key={l.id} launch={l} timezone={timezone} />
                  ))}
                </div>
              )}
              <LaunchPager page={page} search={search} />
            </section>
          </>
        )}
      </div>
    </div>
  );
}
