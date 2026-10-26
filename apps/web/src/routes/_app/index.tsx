import { createFileRoute, Link, useRouter } from '@tanstack/react-router';
import { MotionConfig } from 'motion/react';
import { useEffect } from 'react';
import { LaunchCard } from '../../components/LaunchCard';
import { ApprovalRow, PendingRow } from '../../components/LaunchRows';
import { Empty, PageHead } from '../../components/PageHead';
import { PageToolbar, ToolbarAction } from '../../components/PageToolbar';
import { PlusIcon } from '../../components/ui/icons';
import { EmptyLaunches, Parcels } from '../../components/illustrations';
import { splitLaunches } from '../../server/launch-list';
import { listLaunches } from '../../server/launches.functions';

export const Route = createFileRoute('/_app/')({
  head: () => ({ meta: [{ title: 'Launches · Shipcast' }] }),
  loader: () => listLaunches(),
  component: Launches,
});

function Launches() {
  const { launches, timezone } = Route.useLoaderData();
  const router = useRouter();
  const busy = launches.some((l) => l.status === 'generating');
  const lanes = splitLaunches(launches);
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
        controls={launches.length > 0 && <p className="tb-note">{launches.length === 1 ? '1 launch' : `${launches.length} launches`}</p>}
        actions={<ToolbarAction primary label="Launch a repo" icon={<PlusIcon />} render={<Link to="/launch" />} />}
      />
      {launches.length === 0 ? (
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
        </>
      )}
    </>
  );
}
