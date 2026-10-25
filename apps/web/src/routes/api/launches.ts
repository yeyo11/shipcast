import { createFileRoute } from '@tanstack/react-router';
import { appContext } from '../server/context.server';
import { launchView } from '../server/launches.server';

/** The launches as JSON, for scripts and other tools; behind the same sign-in as the pages */
export const Route = createFileRoute('/api/launches')({
  server: {
    handlers: {
      GET: () => {
        const { registry } = appContext();
        return Response.json(registry.recent(100).map((l) => ({ ...launchView(registry, l), metrics: registry.latestMetrics(l.id) })));
      },
    },
  },
});
