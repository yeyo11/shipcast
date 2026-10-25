import { createFileRoute } from '@tanstack/react-router';
import { FailureLimiter, handleApi, type ApiDeps } from '../../../server/api';
import { appContext } from '../../../server/context.server';
import { approve, startArticle, startLaunch, startPublishing } from '../../../server/work.server';

// One per process, as the failures it counts are
const limiter = new FailureLimiter();

async function deps(): Promise<ApiDeps> {
  const ctx = await appContext();
  return {
    registry: ctx.registry,
    secrets: ctx.secrets,
    github: ctx.github,
    launchesRepo: ctx.deps.launchesRepo,
    publicUrl: ctx.app.publicUrl,
    limiter,
    jobs: async () => ctx.jobs.list().map((j) => ({ id: j.id, title: j.title, state: j.state, log: j.log.slice(-8), link: j.link ?? null, startedAt: j.startedAt })),
    startLaunch,
    approve,
    startArticle,
    startPublishing,
  };
}

/**
 * Every route of the REST API in one server route: the API matches its own paths, so the routes, their
 * scopes and the OpenAPI document come from one table (server/api.ts) rather than a file each.
 */
const serve = async ({ request }: { request: Request }) => handleApi(request, await deps());

export const Route = createFileRoute('/api/v1/$')({
  server: { handlers: { GET: serve, POST: serve, PUT: serve, PATCH: serve, DELETE: serve } },
});
