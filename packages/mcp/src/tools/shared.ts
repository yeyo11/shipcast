import { CHANNELS } from '@shipcast/schema';
import { z } from 'zod';
import type { ShipcastApi } from '../client.ts';

/*
 * What every area's tools are made of. Each tool is a single call of the REST API, so it can do
 * exactly what a token's scopes allow and nothing the app would refuse. The descriptions are written
 * for the model that picks the tool: what it does, when to use it, and what it costs (a public post, a
 * merge, a background job), since that is all the model sees.
 */

/** The MCP tool annotations; WebMCP maps them onto its own (readOnlyHint, consequentialHint) */
export interface ToolHints {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  /** Reaches past Shipcast: GitHub, the networks a post goes out on */
  openWorldHint: boolean;
}

export interface ShipcastTool<S extends z.ZodObject = z.ZodObject> {
  name: string;
  title: string;
  description: string;
  /**
   * The operationIds of /api/v1 the tool calls (apps/web/src/server/api.ts). The app's parity test
   * fails when an operation has no tool, so a new route cannot leave the MCP server behind.
   */
  operations: readonly string[];
  input: S;
  hints: ToolHints;
  run(api: ShipcastApi, args: z.infer<S>): Promise<unknown>;
}

/** A refusal the tool makes itself before calling the API, such as a delete without `confirm` */
export class ToolRefused extends Error {}

/** One preset per kind of tool, so the same kind of call is annotated the same way everywhere */
export const HINTS = {
  /** Only looks */
  read: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  /** Starts work that reaches GitHub or the networks, usually a background job that publishes */
  work: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  /** Changes or removes something already public, on its network */
  destructive: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  /** A write that stays inside Shipcast, such as a setting; doing it twice leaves the same state */
  setting: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
} satisfies Record<string, ToolHints>;

/** Keeps the generic type of each tool while collecting them in one list */
export const tool = <S extends z.ZodObject>(definition: ShipcastTool<S>): ShipcastTool => definition as unknown as ShipcastTool;

/** What a write that starts work answers: the job, to follow with list_jobs */
export const accepted = (answer: unknown, what: string) => ({ ...(answer as object), note: `${what}. It runs as a background job: follow it with list_jobs, then get_launch.` });

export const PUBLISHES = 'Publishing is public and happens once per launch; confirm with the user before calling this.';

/**
 * Refuses an irreversible call the user has not agreed to. The schemas take `confirm: false` on
 * purpose, so the model reads this explanation rather than a bare validation error.
 */
export function requireConfirm(confirm: boolean | undefined, toolName: string, action: string): void {
  if (confirm !== true) throw new ToolRefused(`Nothing was changed. ${action} cannot be undone: ask the user, then call ${toolName} again with confirm: true.`);
}

/* The fields several areas share, described once so a model reads the same words in every tool */

export const launchId = z.number().int().positive().describe('The launch id, as list_launches gives it');
export const postId = z.number().int().positive().describe('The post id, from the `posts` of get_launch');
export const accountId = z.number().int().positive().describe('The account id, as list_accounts gives it');
export const channel = z.enum(CHANNELS).describe('A channel of launch.yml');
export const confirm = z.boolean().optional().describe('Must be true: the user agreed to this, which cannot be undone');
export const cursor = z.string().optional().describe('The `next` value of the previous page');
/** A page size, 1 to 100, as every list of the API takes it */
export const limit = (fallback: number) => z.number().int().min(1).max(100).optional().describe(`How many, 1 to 100; ${fallback} by default`);
