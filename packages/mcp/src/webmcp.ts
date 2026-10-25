import { z } from 'zod';
import { createApiClient, WEBMCP_HEADER, type FetchLike, type ShipcastApi } from './client.ts';
import { invoke } from './errors.ts';
import { TOOLS } from './tools.ts';

/*
 * WebMCP: the same tools as the MCP server, offered to an agent built into the browser while the
 * owner has the app open. Experimental, like the proposal it follows
 * (https://webmachinelearning.github.io/webmcp/): `document.modelContext.registerTool(tool, { signal })`,
 * unregistered by aborting the signal. Early previews put the registry on `navigator.modelContext`
 * and returned a handle with `unregister()`; both are accepted, since browsers are still moving.
 *
 * Browser code: no Node APIs here or in what it imports (test/webmcp.test.ts checks). The tools call
 * the same-origin /api/v1 with the owner's session cookie and WEBMCP_HEADER; the API takes that only
 * while WebMCP is on in the settings, and this module mounts nothing unless told it is on.
 */

export { WEBMCP_HEADER } from './client.ts';

/** WebMCP's own hints: read-only, and "consequential" for what acts on the owner's behalf in public */
export interface WebMcpAnnotations {
  readOnlyHint?: boolean;
  consequentialHint?: boolean;
  untrustedContentHint?: boolean;
}

export interface WebMcpTool {
  name: string;
  title?: string;
  description: string;
  inputSchema?: object;
  execute(input: object, options?: { signal?: AbortSignal }): Promise<unknown>;
  annotations?: WebMcpAnnotations;
}

/** The registry, as the proposal shapes it; the return value is a handle only in early previews */
export interface ModelContextLike {
  registerTool(tool: WebMcpTool, options?: { signal?: AbortSignal }): unknown;
}

export interface MountWebMcpOptions {
  /** The WebMCP setting; nothing is mounted unless it is true, so the experiment stays off by default */
  enabled: boolean;
  /** The registry; found on `document` or `navigator` when left out */
  modelContext?: ModelContextLike;
  /** The API's origin; same-origin when left out */
  baseUrl?: string;
  fetch?: FetchLike;
}

export interface WebMcpMount {
  /** The names of the tools registered */
  tools: string[];
  /** Takes every tool off the registry again */
  unmount(): void;
}

function isRegistry(value: unknown): value is ModelContextLike {
  return typeof value === 'object' && value !== null && typeof (value as { registerTool?: unknown }).registerTool === 'function';
}

/** The browser's registry, when it has one: the proposal's `document.modelContext`, or the previews' `navigator.modelContext` */
export function findModelContext(scope: { document?: unknown; navigator?: unknown } = globalThis): ModelContextLike | undefined {
  for (const holder of [scope.document, scope.navigator]) {
    const candidate = typeof holder === 'object' && holder !== null ? (holder as { modelContext?: unknown }).modelContext : undefined;
    if (isRegistry(candidate)) return candidate;
  }
  return undefined;
}

/** The tools as WebMCP descriptors, over any API client; mountWebMcp uses the session's */
export function webMcpTools(api: ShipcastApi): WebMcpTool[] {
  return TOOLS.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: z.toJSONSchema(tool.input, { io: 'input' }),
    annotations: { readOnlyHint: tool.hints.readOnlyHint, consequentialHint: !tool.hints.readOnlyHint, untrustedContentHint: tool.hints.readOnlyHint },
    async execute(input: object) {
      const outcome = await invoke(tool, api, input);
      // The proposal lets a tool report failure in what it returns, which the agent reads, rather than as a platform error
      return outcome.ok ? outcome.value : { error: outcome.message };
    },
  }));
}

/**
 * Registers Shipcast's tools on the browser's WebMCP registry, for the UI to call once it knows the
 * setting. Answers undefined when WebMCP is off or the browser has no registry.
 */
export function mountWebMcp(options: MountWebMcpOptions): WebMcpMount | undefined {
  if (options.enabled !== true) return undefined;
  const registry = options.modelContext ?? findModelContext();
  if (!registry) return undefined;
  const api = createApiClient({
    baseUrl: options.baseUrl ?? '',
    headers: { [WEBMCP_HEADER]: '1' },
    credentials: 'same-origin',
    ...(options.fetch && { fetch: options.fetch }),
  });
  const controller = new AbortController();
  const handles: Array<{ unregister(): void }> = [];
  const tools = webMcpTools(api);
  for (const tool of tools) {
    const answer = registry.registerTool(tool, { signal: controller.signal });
    if (typeof answer === 'object' && answer !== null && typeof (answer as { unregister?: unknown }).unregister === 'function') handles.push(answer as { unregister(): void });
    // The proposal's registerTool is a promise that rejects when the signal aborts; that is the unmount, not an error
    if (answer instanceof Promise) answer.catch(() => {});
  }
  return {
    tools: tools.map((t) => t.name),
    unmount() {
      controller.abort();
      for (const handle of handles.splice(0)) handle.unregister();
    },
  };
}
