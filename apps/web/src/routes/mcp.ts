import { createFileRoute } from '@tanstack/react-router';
import { createApiClient, createMcpHttpHandler } from '@shipcast/mcp';
import { checkBearer, handleApi, PEER_HEADER } from '../server/api';
import { apiDeps } from '../server/api-deps.server';
import { appContext } from '../server/context.server';

let serving: ((request: Request) => Promise<Response>) | undefined;

/**
 * The MCP server over Streamable HTTP. The tools call the REST API in-process with the caller's own
 * Authorization header, so /mcp has exactly the API's tokens, scopes and checks, with no network hop.
 * See docs/mcp.md and docs/decisions/mcp.md
 */
async function serve({ request }: { request: Request }): Promise<Response> {
  // The public URL is bootstrap and never changes in a process; the rest is read per call, as the API does
  const publicUrl = (await appContext()).app.publicUrl;
  serving ??= createMcpHttpHandler({
    origin: new URL(publicUrl).origin,
    authenticate: async (r) => checkBearer(r, await apiDeps()),
    api: (r) =>
      createApiClient({
        baseUrl: publicUrl,
        headers: { authorization: r.headers.get('authorization') ?? '', [PEER_HEADER]: r.headers.get(PEER_HEADER) ?? '' },
        fetch: async (url, init) => handleApi(new Request(url, init), await apiDeps()),
      }),
    onerror: (error) => console.error(`mcp: ${error.message}`),
  });
  return serving(request);
}

export const Route = createFileRoute('/mcp')({
  server: { handlers: { GET: serve, POST: serve, DELETE: serve } },
});
