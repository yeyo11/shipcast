import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/*
 * The server build loads its routes and server functions on demand: the first request to a page
 * after a restart imports its chunk, and with it every module that chunk needs, while the visitor
 * waits (seconds for a launch page). Warming imports those chunks at boot instead, before the
 * process says it is ready, so no request pays for it.
 */

const LAZY = /import\("(\.\/[^"]+\.js)"\)/g;

/** The chunks a file of the build imports on demand, as absolute paths */
async function lazyImports(file: string): Promise<string[]> {
  const text = await readFile(file, 'utf8');
  return [...new Set([...text.matchAll(LAZY)].map(([, relative]) => join(dirname(file), relative ?? '')))];
}

/**
 * What a request may load on demand: the entry's own lazy chunks (the router, the server
 * functions) and the router's (one per route). A route's own lazy imports are left out: they are
 * the browser's (the tour), and some cannot load in Node at all.
 */
export async function lazyChunks(serverDir: string): Promise<string[]> {
  const first = await lazyImports(join(serverDir, 'server.js'));
  const routers = first.filter((file) => /[\\/]router-[^\\/]+\.js$/.test(file));
  const second = (await Promise.all(routers.map(lazyImports))).flat();
  return [...new Set([...first, ...second])];
}

export interface Warmth {
  /** True once the chunks are loaded, or once the warm-up gave up waiting for them */
  ready(): boolean;
  /** Settles with ready() */
  done: Promise<void>;
}

/**
 * Imports the build's lazy chunks. A chunk that fails is reported and skipped (its request would
 * fail the same way, and say so then); a warm-up that takes longer than timeoutMs stops holding
 * readiness, so a slow or stuck import never keeps the process out of rotation for good.
 */
export function warm(serverDir: string, timeoutMs: number, log: (line: string) => void = console.warn): Warmth {
  let ready = false;
  let timer: NodeJS.Timeout | undefined;
  const work = (async () => {
    const chunks = await lazyChunks(serverDir);
    const results = await Promise.allSettled(chunks.map((file) => import(pathToFileURL(file).href)));
    const failed = results.flatMap((r, i) => (r.status === 'rejected' ? [`${chunks[i] ?? '?'}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`] : []));
    for (const line of failed) log(`warm-up: a chunk did not load (${line})`);
  })().catch((error: unknown) => log(`warm-up failed: ${error instanceof Error ? error.message : String(error)}`));
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      log(`warm-up: still loading after ${timeoutMs} ms; ready anyway`);
      resolve();
    }, timeoutMs);
  });
  const done = Promise.race([work, timeout]).then(() => {
    clearTimeout(timer);
    ready = true;
  });
  return { ready: () => ready, done };
}
