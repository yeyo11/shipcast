import { after } from 'node:test';
import type { PGlite } from '@electric-sql/pglite';
import { SdkProvider } from './ai.ts';
import { connectPglite } from './db/connect.ts';
import { Registry } from './registry.ts';

/*
 * Registries for tests, on PGlite: a real Postgres in the test process, no server and no docker.
 * Starting PGlite and migrating it takes seconds, so one migrated instance per test file is the
 * template and every registry is a clone of it, in a fraction of that.
 */

export { connectPglite };

let template: Promise<{ client: PGlite; close(): Promise<void> }> | undefined;
const open: Array<{ close(): Promise<void> }> = [];

// Several PGlite instances left open keep the process alive, and `node --test` would wait forever
after(async () => {
  await Promise.all(open.splice(0).map((each) => each.close()));
  if (template) await (await template).close();
});

/** A clone of a PGlite instance, closed when the test file ends */
export async function clonePglite(client: PGlite): Promise<PGlite> {
  // clone() is typed as the interface, but it is a PGlite, which is what Drizzle's driver takes
  const clone = (await client.clone()) as PGlite;
  open.push(clone);
  return clone;
}

/** A registry over a PGlite whose registry schema is already migrated */
export async function registryOn(client: PGlite): Promise<Registry> {
  const { drizzle } = await import('drizzle-orm/pglite');
  return new Registry(drizzle({ client }));
}

/** A fresh, empty registry, closed when the test file ends */
export async function memoryRegistry(): Promise<Registry> {
  template ??= connectPglite();
  return registryOn(await clonePglite((await template).client));
}

/** What a mock streaming provider was asked, for assertions */
export interface StreamCall {
  system?: string;
  prompt?: string;
  messages?: unknown;
}

/**
 * A provider on the AI SDK's mock model that streams the given pieces of text: the real SdkProvider
 * code path, without a network. Every request is recorded in `calls`.
 */
export async function mockStreamingProvider(pieces: string[], calls: StreamCall[] = []): Promise<SdkProvider> {
  const { convertArrayToReadableStream, MockLanguageModelV4 } = await import('ai/test');
  const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      const system = options.prompt.find((m) => m.role === 'system');
      const users = options.prompt.filter((m) => m.role !== 'system');
      calls.push({
        ...(system && typeof system.content === 'string' && { system: system.content }),
        ...(users.length === 1 && users[0]!.role === 'user' && { prompt: users[0]!.content.map((p) => (p.type === 'text' ? p.text : '')).join('') }),
        messages: users,
      });
      return {
        stream: convertArrayToReadableStream([
          { type: 'text-start' as const, id: 't' },
          ...pieces.map((delta) => ({ type: 'text-delta' as const, id: 't', delta })),
          { type: 'text-end' as const, id: 't' },
          { type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: undefined }, usage },
        ]),
      };
    },
  });
  return new SdkProvider({ id: 'test', model: () => model });
}
