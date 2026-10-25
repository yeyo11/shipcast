import { ShipcastApiError, type ShipcastApi } from './client.ts';
import { ToolRefused, type ShipcastTool } from './tools.ts';

export type ToolOutcome = { ok: true; value: unknown } | { ok: false; message: string };

/**
 * Runs a tool on arguments that may not have been checked yet (WebMCP hands them over as they came),
 * and turns every failure into the message a model reads, so neither front end throws at its caller.
 */
export async function invoke(tool: ShipcastTool, api: ShipcastApi, args: unknown): Promise<ToolOutcome> {
  const parsed = tool.input.safeParse(args ?? {});
  if (!parsed.success) {
    return { ok: false, message: `Invalid arguments for ${tool.name}: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}` };
  }
  try {
    return { ok: true, value: await tool.run(api, parsed.data) };
  } catch (error) {
    return { ok: false, message: describeError(error) };
  }
}

/*
 * What a model reads when a tool fails. The API's code says what kind of failure it was; the text adds
 * what to do next, since a model retrying a 409 or a 403 as it is only fails again.
 */

const NEXT: Record<ShipcastApiError['code'], string> = {
  unauthorized: 'The Shipcast token was refused (missing, wrong or revoked). Make a new one with `pnpm shipcast token create <name> --scopes read,write` or on the app\'s API page (/tokens), and give it to the MCP server as SHIPCAST_API_TOKEN.',
  insufficient_scope: 'The Shipcast token lacks a scope this tool needs. Make a token with both scopes: --scopes read,write.',
  rate_limited: 'Too many wrong tokens came from this client; wait before trying again.',
  not_found: 'No such launch or post. Use list_launches and get_launch to find the right id.',
  method_not_allowed: 'This Shipcast app does not serve that call; it may be older than this MCP server.',
  invalid_input: 'Fix the arguments and call again.',
  unsupported_media_type: 'This Shipcast app did not accept the request body; it may be older than this MCP server.',
  refused: 'Shipcast refused the work. Do not retry it as it is: tell the user why.',
  upstream: 'The network refused the change; its own words are above.',
  internal: 'Shipcast failed on its side; the details are in the app\'s log.',
  unreachable: 'Check SHIPCAST_API_URL and that the app is running.',
  bad_response: 'Check SHIPCAST_API_URL points at a Shipcast app.',
};

/** One line or two for the model; never the token, which the client already took out of every message */
export function describeError(error: unknown): string {
  if (error instanceof ToolRefused) return error.message;
  if (error instanceof ShipcastApiError) {
    const wait = error.code === 'rate_limited' && error.retryAfter ? ` Retry after ${error.retryAfter} s.` : '';
    const status = error.status > 0 ? ` (${error.status} ${error.code})` : ` (${error.code})`;
    return `${error.message}${status}. ${NEXT[error.code]}${wait}`;
  }
  // Anything else is a bug here, not something the model can act on; keep its message short
  return `The Shipcast tool failed: ${error instanceof Error ? error.message : String(error)}`;
}
