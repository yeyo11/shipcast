import { createFileRoute, Link, useRouter } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { EmptyLaunches } from '../../components/illustrations';
import { Icon } from '../../components/kit/Icon';
import { TopBar } from '../../components/kit/Bars';
import { badgeText, useShell } from '../../components/kit/shell';
import { LaunchCard, QuietRow, type HomeLaunch } from '../../components/LaunchCard';
import { FilterMenus, FilterSheet, LaunchPager, SearchBox, useLaunchesNavigate } from '../../components/LaunchFilters';
import { ApprovalCard, AttentionRow, attentionRows } from '../../components/LaunchRows';
import { useLiveEnabled, useLiveRoute } from '../../components/live/Live';
import { homeGroups, listedFailures } from '../../server/launch-list';
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

function Head({ empty, tour }: { empty: boolean; tour: boolean }) {
  return (
    <div className="home-head" data-tour={tour ? 'launches' : undefined}>
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

/** How many of the "Not published" rows show before "Show all" */
const QUIET_ROWS = 3;

/**
 * The launches that never went out (not launched, failed before anything went out, every piece taken
 * down), one line each below the cards: a few, then the rest a click away. Open from the start when a
 * search or a filter asked for them.
 */
function NotPublished({ launches, timezone, open, deletable }: { launches: HomeLaunch[]; timezone: string; open: boolean; deletable: boolean }) {
  const [all, setAll] = useState(open);
  useEffect(() => setAll(open), [open]);
  const shown = all ? launches : launches.slice(0, QUIET_ROWS);
  const more = launches.length - QUIET_ROWS;
  return (
    <section className="home-quiet" aria-labelledby="home-quiet">
      <div className="k-hrow k-between">
        <h3 id="home-quiet" className="k-d k-d24">
          Not published
        </h3>
        <span className="k-sm k-muted">{launches.length}</span>
      </div>
      <ul id="home-quiet-list" className="k-stack home-quiet-list">
        {shown.map((l) => (
          <QuietRow key={l.id} launch={l} timezone={timezone} deletable={deletable} />
        ))}
      </ul>
      {more > 0 && (
        <button type="button" className="k-btn k-sm home-quiet-more" aria-expanded={all} aria-controls="home-quiet-list" onClick={() => setAll(!all)}>
          {all ? 'Show fewer' : `Show all ${launches.length}`}
        </button>
      )}
    </section>
  );
}

function Launches() {
  const { launches, page, facets, timezone, deletable } = Route.useLoaderData();
  const search = Route.useSearch();
  const go = useLaunchesNavigate(search);
  const router = useRouter();
  const { attention } = useShell();
  const list = launches as HomeLaunch[];
  const busy = list.some((l) => l.status === 'generating' || l.status === 'detected');
  // Every launch there is, whatever the filters: an empty registry is the first run, not a search with no match
  const any = facets.statuses.some((s) => s.count > 0);
  const narrowed = Object.keys(search).some((k) => k !== 'page' && k !== 'sort');
  // A search or a filter is about the list: what waits for approval shows among its cards then.
  // What never went out leaves the grid for the "Not published" rows, and a failure what needs you
  // already lists is not shown again as a card
  const groups = homeGroups(list, { narrowed, listedFailures: listedFailures(attention?.items ?? []) });
  const approvals = groups.approval;
  const rest = groups.card;
  const quiet = groups.quiet;
  const rows = attentionRows(attention?.items ?? []);
  const count = attention?.count ?? 0;
  // Live: the list is read again when a launch, a piece or a launch's numbers change
  const live = useLiveEnabled();
  useLiveRoute(Route.id, live ? ['launch', 'post', 'metrics'] : null);
  // Otherwise, while something runs, the page follows it by polling
  useEffect(() => {
    if (live || !busy) return;
    const timer = setInterval(() => router.invalidate(), 5000);
    return () => clearInterval(timer);
  }, [live, busy, router]);

  const needs = approvals.length > 0 || rows.length > 0;
  return (
    <div className="home">
      <TopBar />
      <div className="home-page">
        <Head empty={!any} tour={!needs || !any} />
        {!any ? (
          <FirstRun />
        ) : (
          <>
            {needs && (
              <section data-tour={approvals.length > 0 ? undefined : 'launches'} className={`home-needs${approvals.length > 0 ? '' : ' home-needs-rows'}`} aria-labelledby="home-needs">
                <div className="home-needs-top" data-tour={approvals.length > 0 ? 'launches' : undefined}>
                  <h2 id="home-needs" className="k-hrow k-g8 k-lbl home-needs-head k-phone-flex">
                  Waiting for you {count > 0 && <span className="k-badge">{badgeText(count)}</span>}
                </h2>
                {approvals.length > 0 && (
                  <div className="k-stack k-g16 home-approvals">
                    {approvals.map((l) => (
                      <ApprovalCard key={l.id} launch={l} />
                    ))}
                  </div>
                )}
                </div>
                {rows.length > 0 && (
                  <div className="home-also">
                    <div className="k-hrow k-between k-desktop-flex">
                      <h2 className="k-d k-d30">{approvals.length > 0 ? 'Also needs you' : 'Needs you'}</h2>
                      <span className="k-badge">{badgeText(rows.length)}</span>
                    </div>
                    <ul className="k-stack home-rows">
                      {rows.map((item) => (
                        <AttentionRow key={item.key} item={item} network={network} deletable={deletable} />
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
              {rest.length === 0 && quiet.length === 0 ? (
                <div className="k-stack k-g12 home-nomatch">
                  <p className="k-muted">{narrowed ? 'No launch matches these filters.' : approvals.length > 0 ? 'Nothing else yet.' : 'No launches on this page.'}</p>
                  {narrowed && (
                    <button type="button" className="k-btn k-sm" onClick={() => go({ q: undefined, status: undefined, trigger: undefined, kind: undefined, repo: undefined })}>
                      Show every launch
                    </button>
                  )}
                </div>
              ) : (
                rest.length > 0 && (
                  <div className="home-grid">
                    {rest.map((l) => (
                      <LaunchCard key={l.id} launch={l} timezone={timezone} />
                    ))}
                  </div>
                )
              )}
              {quiet.length > 0 && <NotPublished launches={quiet} timezone={timezone} open={narrowed} deletable={deletable} />}
              <LaunchPager page={page} search={search} />
            </section>
          </>
        )}
      </div>
    </div>
  );
}
