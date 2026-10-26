import { createFileRoute, Link, useRouter } from '@tanstack/react-router';
import { MotionConfig } from 'motion/react';
import { useEffect } from 'react';
import { LaunchCard } from '../../components/LaunchCard';
import { Empty, PageHead } from '../../components/PageHead';
import { PageToolbar, ToolbarAction } from '../../components/PageToolbar';
import { PlusIcon } from '../../components/ui/icons';
import { EmptyLaunches, Parcels } from '../../components/illustrations';
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
        // Counting numbers and morphing charts, instant for whoever asks the system for reduced motion
        <MotionConfig reducedMotion="user">
          <div className="lcards">
            {launches.map((launch) => (
              <LaunchCard key={launch.id} launch={launch} numbers={launch.numbers} postAccounts={launch.postAccounts} timezone={timezone} />
            ))}
          </div>
        </MotionConfig>
      )}
    </>
  );
}
