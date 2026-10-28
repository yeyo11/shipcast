import type { OneTimeStore } from '@shipcast/runtime/redis';
import { processState } from '@shipcast/runtime/redis';

/**
 * Single-use sign-in links printed in the app's terminal: a way in that needs no GitHub, for whoever
 * can read the app's own output (the owner, or an agent the owner runs it for). Kept in the process's
 * one-time store: this process's memory, or Redis with `redis-state` on, so a link printed by one
 * replica signs in on whichever replica the proxy sends the browser to. The store is per process on
 * globalThis, because the process that prints them (the launcher, or Vite in development) and the
 * bundled app that redeems them load this module separately.
 */
class ConsoleLinks {
  readonly #store: OneTimeStore;

  constructor(store: OneTimeStore) {
    this.#store = store;
  }

  create(ttlMs = 15 * 60_000): Promise<string> {
    return this.#store.put('console-link', 1, Math.ceil(ttlMs / 1000));
  }

  /** Taken once, by whichever replica gets it first */
  async redeem(token: string): Promise<boolean> {
    if (!token) return false;
    return (await this.#store.take('console-link', token)) !== undefined;
  }
}

export function consoleLinks(store: OneTimeStore = processState().shared.oneTime): ConsoleLinks {
  return new ConsoleLinks(store);
}

/** The path a console link opens */
export const signInPath = (token: string) => `/auth/link?token=${token}`;
