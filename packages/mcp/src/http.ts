import { createMcpHandler } from '@modelcontextprotocol/server';
import type { ShipcastApi } from './client.ts';
import { createShipcastServer } from './server.ts';

/*
 * The MCP server over Streamable HTTP, which the app serves at /mcp for clients on other machines.
 * Stateless: every request gets a fresh server over an API client built for that request, so the
 * caller's own token (and its scopes) is what every tool call runs under, and nothing is kept between
 * requests that a restart could lose.
 */

export interface McpHttpOptions {
  /** Refuses a request whose token is missing or wrong, with the API's answer; nothing when it is good */
  authenticate(request: Request): Promise<Response | undefined>;
  /** The API client a request's tools call, carrying that request's token */
  api(request: Request): ShipcastApi;
  /** The app's own origin: a browser request from any other is refused, against DNS rebinding */
  origin: string;
  onerror?: (error: Error) => void;
}

const refusal = (status: number, message: string) => Response.json({ error: { code: status === 403 ? 'forbidden' : 'invalid_input', message } }, { status, headers: { 'cache-control': 'no-store' } });

export function createMcpHttpHandler(options: McpHttpOptions): (request: Request) => Promise<Response> {
  const handler = createMcpHandler(
    (ctx) => {
      // createMcpHandler hands the request it is serving to the factory; it is always there over HTTP
      if (!ctx.requestInfo) throw new Error('the MCP endpoint needs the HTTP request');
      return createShipcastServer(options.api(ctx.requestInfo));
    },
    { ...(options.onerror && { onerror: options.onerror }) },
  );
  return async (request) => {
    const origin = request.headers.get('origin');
    if (origin !== null && origin !== options.origin) return refusal(403, `requests from ${origin} are not accepted`);
    const refused = await options.authenticate(request);
    if (refused) return refused;
    return handler.fetch(request);
  };
}
