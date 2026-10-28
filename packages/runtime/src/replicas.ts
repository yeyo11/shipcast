import type { EventName, ShipcastEvents } from './redis/ports.ts';
import type { SharedState } from './redis/state.ts';

/*
 * What every replica caches and must drop when another replica changes it: the settings (each
 * process reads them once and keeps them), the brand (read from the launches repo every few
 * minutes) and the GitHub App's installation (looked up once). With the shared state on Redis
 * (`redis-state`), a change is announced on the event bus and every replica, this one included,
 * reacts to it; in memory there is no other replica, so this process reacts directly, as before.
 */

export interface ReplicaCaches {
  /** Reads the settings again */
  refresh(): Promise<void>;
  invalidateBrand(): void;
  githubApp?: { refresh(): void } | undefined;
}

export interface ReplicaEvents {
  /** Tells every replica (this one too) of a change to something they cache */
  announce<E extends EventName>(event: E, payload: ShipcastEvents[E]): Promise<void>;
  /** After a save in Settings: this process reads them again at once, and every other one is told */
  settingsSaved(key?: string): Promise<void>;
}

const CACHE_EVENTS = ['settings.changed', 'github.installation.changed', 'brand.changed'] as const;

export async function replicaEvents(shared: Pick<SharedState, 'events' | 'backend'>, caches: ReplicaCaches, log: (line: string) => void = (line) => console.error(line)): Promise<ReplicaEvents> {
  const react = async (event: EventName) => {
    if (event === 'settings.changed') {
      await caches.refresh();
      caches.invalidateBrand();
    } else if (event === 'github.installation.changed') caches.githubApp?.refresh();
    else if (event === 'brand.changed') caches.invalidateBrand();
  };
  const onEvent = (event: EventName) => () =>
    void react(event).catch((error: unknown) => log(`${event}: ${error instanceof Error ? error.message : String(error)}`));
  const distributed = shared.backend === 'redis';
  if (distributed) {
    for (const event of CACHE_EVENTS) await shared.events.subscribe(event, onEvent(event));
    // Events sent while the subscription was down are lost: read again what they would have said
    shared.events.onReconnect(() => {
      onEvent('settings.changed')();
      caches.githubApp?.refresh();
    });
  }
  return {
    announce: async (event, payload) => {
      if (distributed) await shared.events.publish(event, payload);
      else await react(event);
    },
    settingsSaved: async (key = 'settings') => {
      await caches.refresh();
      if (distributed) await shared.events.publish('settings.changed', { key });
    },
  };
}
