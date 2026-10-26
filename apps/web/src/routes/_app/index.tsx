import { createFileRoute, Link, useRouter } from '@tanstack/react-router';
import { MotionConfig } from 'motion/react';
import { useEffect } from 'react';
import { LaunchCard } from '../../components/LaunchCard';
import { Empty, PageHead } from '../../components/PageHead';
import { EmptyLaunches } from '../../components/illustrations';
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

  const waiting = launches.filter((l) => l.state.tone === 'waiting');
  return (
    <>
      <PageHead
        title="Launches"
        action={
          <Link className="btn btn-primary" to="/launch">
            Launch a repo
          </Link>
        }
      >
        Every launch, where it went and how it did.
      </PageHead>
      {waiting.length > 0 && (
        <div className="band band-yellow">
          <h2 className="ph" style={{ margin: 0 }}>
            {waiting.length === 1 ? '1 launch waits for you' : `${waiting.length} launches wait for you`}
          </h2>
          <p className="muted" style={{ margin: '10px 0 0' }}>
            Review the drafts and approve them: approving publishes on every channel.
          </p>
        </div>
      )}
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
