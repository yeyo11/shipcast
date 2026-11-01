import * as accounts from './accounts.ts';
import * as comments from './comments.ts';
import * as jobs from './jobs.ts';
import * as launches from './launches.ts';
import * as posts from './posts.ts';
import * as profiles from './profiles.ts';
import type { ShipcastTool } from './shared.ts';
import * as schedule from './schedule.ts';
import * as sources from './sources.ts';
import * as stats from './stats.ts';

/*
 * Shipcast's tools, defined once for both the MCP server and WebMCP, one module per area of the REST
 * API. An area adds its tools to its own module and describes them in its `guide`, so it never edits a
 * list shared with the other areas.
 */

export { ToolRefused, type ShipcastTool, type ToolHints } from './shared.ts';

/** What every area module exports */
export interface ToolArea {
  tools: readonly ShipcastTool[];
  /** The area's paragraph of the server's instructions: when to use its tools and what they cost; '' while it has none */
  guide: string;
}

const AREAS: readonly ToolArea[] = [launches, posts, accounts, jobs, stats, schedule, comments, profiles, sources];

export const TOOLS: ShipcastTool[] = AREAS.flatMap((area) => area.tools);

/** The areas' guides, in the order of their tools */
export const TOOL_GUIDES: readonly string[] = AREAS.map((area) => area.guide).filter((guide) => guide !== '');

export const toolByName = (name: string): ShipcastTool | undefined => TOOLS.find((t) => t.name === name);
