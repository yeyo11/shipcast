import { randomBytes } from 'node:crypto';

/**
 * Single-use sign-in links printed in the app's terminal: a way in that needs no GitHub, for whoever
 * can read the app's own output (the owner, or an agent the owner runs it for). Kept on globalThis
 * because the process that prints them (the launcher, or Vite in development) and the bundled app
 * that redeems them load this module separately.
 */
class ConsoleLinks {
  readonly #tokens = new Map<string, number>();

  create(ttlMs = 15 * 60_000): string {
    const token = randomBytes(24).toString('base64url');
    this.#tokens.set(token, Date.now() + ttlMs);
    return token;
  }

  redeem(token: string): boolean {
    const expires = this.#tokens.get(token);
    this.#tokens.delete(token);
    return expires !== undefined && expires > Date.now();
  }
}

const store = globalThis as { __shipcastConsoleLinks?: ConsoleLinks };

export function consoleLinks(): ConsoleLinks {
  store.__shipcastConsoleLinks ??= new ConsoleLinks();
  return store.__shipcastConsoleLinks;
}

/** The path a console link opens */
export const signInPath = (token: string) => `/auth/link?token=${token}`;
