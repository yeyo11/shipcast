import { useEffect } from 'react';

/**
 * Offers Shipcast's tools to an agent built into the browser while the app is open, when the owner
 * turned the WebMCP experiment on. The module is loaded only then, so the shell carries none of it
 * while it is off; a browser without the proposal's registry gets nothing registered.
 */
export function WebMcpHost({ enabled }: { enabled: boolean }) {
  useEffect(() => {
    if (!enabled) return;
    let unmount: (() => void) | undefined;
    let gone = false;
    void import('@shipcast/mcp/webmcp').then(({ mountWebMcp }) => {
      if (gone) return;
      unmount = mountWebMcp({ enabled: true })?.unmount;
    });
    return () => {
      gone = true;
      unmount?.();
    };
  }, [enabled]);
  return null;
}
