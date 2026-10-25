import { createFileRoute } from '@tanstack/react-router';
import { handleApi } from '../../../server/api';
import { apiDeps } from '../../../server/api-deps.server';

/**
 * Every route of the REST API in one server route: the API matches its own paths, so the routes, their
 * scopes and the OpenAPI document come from one table (server/api.ts) rather than a file each.
 */
const serve = async ({ request }: { request: Request }) => handleApi(request, await apiDeps());

export const Route = createFileRoute('/api/v1/$')({
  server: { handlers: { GET: serve, POST: serve, PUT: serve, PATCH: serve, DELETE: serve } },
});
