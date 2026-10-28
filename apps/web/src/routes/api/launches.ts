import { createFileRoute } from '@tanstack/react-router';
import { appContext } from '../../server/context.server';
import { jobsView } from '../../server/jobs.server';
import { launchView } from '../../server/launches.server';

/** The launches as JSON, for scripts and other tools; behind the same sign-in as the pages */
export const Route = createFileRoute('/api/launches')({
  server: {
    handlers: {
      GET: async () => {
        const { registry } = await appContext();
        const launches = await registry.launches.recent(100);
        return Response.json(
          await Promise.all(
            launches.map(async (l) => ({ ...(await launchView(registry, l)), metrics: await registry.metrics.latestMetrics(l.id), jobs: await jobsView(registry, { launchId: l.id }) })),
          ),
        );
      },
    },
  },
});
