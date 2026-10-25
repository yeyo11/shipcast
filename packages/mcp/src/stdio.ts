import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import { createApiClient, type FetchLike } from './client.ts';
import { createShipcastServer } from './server.ts';

/*
 * `shipcast mcp`: the MCP server over stdio, for Claude Code, Claude Desktop and any local client. It
 * holds no database or keychain of its own; it calls the app's REST API with a token, so it runs on any
 * machine that can reach the app, under that token's scopes. Its stdout is the protocol: everything
 * else goes to stderr.
 */

export interface StdioOptions {
  /** The app's origin, https://host */
  url: string;
  token: string;
  fetch?: FetchLike;
}

export class McpSetupError extends Error {}

export function checkStdioOptions(options: { url: string | undefined; token: string | undefined }): { url: string; token: string } {
  const url = options.url?.trim().replace(/\/+$/, '');
  if (!url) throw new McpSetupError('shipcast mcp needs the app\'s URL: set SHIPCAST_API_URL (or --url), like https://shipcast.example');
  if (!/^https?:\/\/[^/\s]+$/.test(url)) throw new McpSetupError(`SHIPCAST_API_URL must be the app's origin, http(s)://host, not "${url}"`);
  const token = options.token?.trim();
  if (!token) throw new McpSetupError('shipcast mcp needs a token: set SHIPCAST_API_TOKEN (make one with `pnpm shipcast token create "MCP" --scopes read,write` or on the app\'s API page)');
  // Only the shape is checked here; the app checks the token itself on the first call
  if (!/^shipcast_\d+_[A-Za-z0-9_-]+$/.test(token)) throw new McpSetupError('SHIPCAST_API_TOKEN does not look like a Shipcast token (shipcast_<id>_<secret>)');
  return { url, token };
}

export function serveShipcastStdio(options: StdioOptions): StdioServerHandle {
  const api = createApiClient({ baseUrl: options.url, token: options.token, ...(options.fetch && { fetch: options.fetch }) });
  return serveStdio(() => createShipcastServer(api), { onerror: (error) => console.error(`shipcast mcp: ${error.message}`) });
}
