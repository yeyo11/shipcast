import { after } from 'node:test';
import type { PGlite } from '@electric-sql/pglite';
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
