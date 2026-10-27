import { createFileRoute, Link, useRouter } from '@tanstack/react-router';
import { MotionConfig } from 'motion/react';
import { useEffect } from 'react';
import { LaunchCard } from '../../components/LaunchCard';
import { LaunchFilters, LaunchPager, useLaunchesNavigate } from '../../components/LaunchFilters';
import { ApprovalRow, PendingRow } from '../../components/LaunchRows';
import { Empty, PageHead } from '../../components/PageHead';
import { PageToolbar, ToolbarAction } from '../../components/PageToolbar';
import { PlusIcon } from '../../components/ui/icons';
import { EmptyLaunches, Parcels } from '../../components/illustrations';
import { splitLaunches } from '../../server/launch-list';
import { readLaunchesSearch, type LaunchesSearch } from '../../server/launches-search';
import { listLaunches } from '../../server/launches.functions';

/*
 * Every launch, a page at a time: the filters, the words and the order are in the address and
 * applied by the database (docs/decisions/lists.md). Each page keeps the list's layout: what waits
 * for the owner as rows above, what went out as a grid of equal cards.
 */
export const Route = createFileRoute('/_app/')({
  head: () => ({ meta: [{ title: 'Launches · Shipcast' }] }),
  validateSearch: (search: Record<string, unknown>): LaunchesSearch => readLaunchesSearch(search),
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => listLaunches({ data: deps }),
  component: Launches,
});

function Launches() {
  const { launches, page, facets, timezone } = Route.useLoaderData();
  const search = Route.useSearch();
  const go = useLaunchesNavigate(search);
  const router = useRouter();
  const busy = launches.some((l) => l.status === 'generating');
  const lanes = splitLaunches(launches);
  // Every launch there is, whatever the filters: an empty registry is the first run, not a search with no match
  const any = facets.statuses.some((s) => s.count > 0);
  const narrowed = Object.keys(search).some((k) => k !== 'page' && k !== 'sort');
  // While something runs, the page follows it without a reload
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => router.invalidate(), 5000);
    return () => clearInterval(timer);
  }, [busy, router]);

  return (
    <>
      <PageHead title="Launches" art={<Parcels width={200} />}>
        Every launch, where it went and how it did.
      </PageHead>
      <PageToolbar
        label="Launches"
        controls={
          any && (
            <>
              <LaunchFilters search={search} facets={facets} />
              <p className="tb-note" aria-live="polite">
                {page.total === 1 ? '1 launch' : `${page.total} launches`}
              </p>
            </>
          )
        }
        actions={<ToolbarAction primary label="Launch a repo" icon={<PlusIcon />} render={<Link to="/launch" />} />}
      />
      {!any ? (
        <Empty
          art={<EmptyLaunches width={280} />}
          title="No launches yet"
          action={
            <Link className="btn" to="/write">
              Write an article
            </Link>
          }
        >
          Launch a repo with a release and a .github/launch.yml, or write an article of your own.
        </Empty>
      ) : launches.length === 0 ? (
        <div className="launch-nomatch">
          <p className="muted">{narrowed ? 'No launch matches these filters.' : 'No launches on this page.'}</p>
          {narrowed && (
            <button type="button" className="btn btn-small" onClick={() => go({ q: undefined, status: undefined, trigger: undefined, kind: undefined, repo: undefined })}>
              Show every launch
            </button>
          )}
        </div>
      ) : (
        <>
          {(lanes.approval.length > 0 || lanes.pending.length > 0) && (
            <ul className="lrows" aria-label="Launches that wait">
              {lanes.approval.map((launch) => (
                <ApprovalRow key={launch.id} launch={launch} timezone={timezone} avatarUrl={launch.avatarUrl} />
              ))}
              {lanes.pending.map((launch) => (
                <PendingRow key={launch.id} launch={launch} timezone={timezone} avatarUrl={launch.avatarUrl} />
              ))}
            </ul>
          )}
          {/* Counting numbers and morphing charts, instant for whoever asks the system for reduced motion */}
          {lanes.out.length > 0 && (
            <MotionConfig reducedMotion="user">
              <div className="lcards">
                {lanes.out.map((launch) => (
                  <LaunchCard key={launch.id} launch={launch} numbers={launch.numbers} postAccounts={launch.postAccounts} timezone={timezone} avatarUrl={launch.avatarUrl} />
                ))}
              </div>
            </MotionConfig>
          )}
          <LaunchPager page={page} search={search} />
        </>
      )}
    </>
  );
}
