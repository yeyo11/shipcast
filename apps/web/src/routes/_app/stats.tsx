import { createFileRoute, Link } from '@tanstack/react-router';
import { Empty, PageHead } from '../../components/PageHead';
import { OnboardMeasure } from '../../components/illustrations';

// A place in the navigation before the section exists, so the phone's bottom bar keeps its four
// sections from now on; the charts come in milestone 5 of docs/plans/goal-after-mvp.md
export const Route = createFileRoute('/_app/stats')({
  head: () => ({ meta: [{ title: 'Stats · Shipcast' }] }),
  component: Stats,
});

function Stats() {
  return (
    <>
      <PageHead title="Stats">How every launch did, channel by channel, over time.</PageHead>
      <Empty art={<OnboardMeasure width={280} />} title="Coming soon" action={<Link className="btn" to="/">See each launch’s numbers</Link>}>
        Charts across launches and channels are on their way. Until then, each launch’s page has its latest numbers by source.
      </Empty>
    </>
  );
}
