import { after } from 'node:test';
import type { PGlite } from '@electric-sql/pglite';
import { connectPglite } from './db/connect.ts';
import { Registry } from './registry.ts';

/*
 * Registries for tests, on PGlite: a real Postgres in the test process, no server and no docker.
 * Starting PGlite and migrating it takes seconds, so one migrated instance per test file is the
 * template and every registry is a clone of it, in a fraction of that.
 */

let template: Promise<{ client: PGlite; close(): Promise<void> }> | undefined;
const open: Registry[] = [];

// Several PGlite instances left open keep the process alive, and `node --test` would wait forever
after(async () => {
  await Promise.all(open.splice(0).map((registry) => registry.close()));
  if (template) await (await template).close();
});

/** A fresh, empty registry, closed when the test file ends */
export async function memoryRegistry(): Promise<Registry> {
  template ??= connectPglite();
  const { client } = await template;
  const { drizzle } = await import('drizzle-orm/pglite');
  // clone() is typed as the interface, but it is a PGlite, which is what Drizzle's driver takes
  const clone = (await client.clone()) as PGlite;
  const registry = new Registry(drizzle({ client: clone }), () => clone.close());
  open.push(registry);
  return registry;
}
