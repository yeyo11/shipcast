import type { Repositories } from '@shipcast/engine';

/*
 * WebMCP, the experiment that offers Shipcast's tools to an agent built into the owner's browser, is
 * off until the owner turns it on. Off means both halves: the app does not mount the tools, and the
 * API refuses the session-cookie calls they make. See docs/decisions/mcp.md
 */

const KEY = 'webmcp:enabled';

export async function readWebMcp(registry: Repositories): Promise<boolean> {
  return (await registry.settings.setting<boolean>(KEY)) === true;
}

export async function writeWebMcp(registry: Repositories, enabled: boolean): Promise<boolean> {
  await registry.settings.setSetting<boolean>(KEY, enabled);
  return readWebMcp(registry);
}
