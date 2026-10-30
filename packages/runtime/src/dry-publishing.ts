import { bindStrategy, type ChannelPublishing, type DryPublishing, type Publishers } from '@shipcast/engine';
import { CHANNEL_ADAPTERS, type AnyChannelAdapter } from './channels/index.ts';

/**
 * Every channel's publisher and strategy as `buildServices` wires them, over a connector that never
 * reaches its network: any call on it is recorded (`<channel> <method>`) and refused. What the import's
 * verification runs publishing with (docs/launch-import.md), to show nothing would go out.
 */
export function dryPublishing(adapters: readonly AnyChannelAdapter[] = CHANNEL_ADAPTERS): DryPublishing {
  const calls: string[] = [];
  const publishers: Publishers = {};
  const strategies: Record<string, ChannelPublishing> = {};
  for (const adapter of adapters) {
    const channel = adapter.definition.id;
    const connector = new Proxy(
      {},
      {
        get: (_, method) =>
          // Not a thenable, so awaiting the connector is not a call on it
          typeof method === 'symbol' || method === 'then'
            ? undefined
            : (..._args: unknown[]) => {
                calls.push(`${channel} ${method}`);
                throw new Error(`dry run: ${channel} ${method} was not called`);
              },
      },
    );
    const publisher = adapter.publisher(connector);
    if (adapter.strategy) strategies[channel] = bindStrategy(adapter.strategy, publisher);
    else Object.assign(publishers, { [channel]: publisher });
  }
  return { publishers, strategies, calls };
}
