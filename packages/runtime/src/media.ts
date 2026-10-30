import { R2MediaStore, unavailableMediaStore, type MediaStore } from '@shipcast/engine';
import { loadMediaStoreConfig, MEDIA_STORE_VARIABLES } from './config.ts';
import type { Flags } from './flags.ts';

/**
 * The process's media store (docs/media-store.md): R2 with `launch-media` on and its bucket in .env;
 * otherwise one that refuses every call saying why, so a phase that reaches for media before it is
 * set up fails at that call with the reason, not later with a missing file.
 */
export function mediaStoreFor(flags: Flags, env: NodeJS.ProcessEnv, options: { fetch?: typeof fetch } = {}): MediaStore {
  if (!flags.on('launch-media')) return unavailableMediaStore('the launch-media flag is off (SHIPCAST_FLAGS)');
  const config = loadMediaStoreConfig(env);
  if (!config) return unavailableMediaStore(`missing in .env: ${MEDIA_STORE_VARIABLES.join(', ')} (see .env.example)`);
  const { region, ...bucket } = config;
  return new R2MediaStore({ ...bucket, ...(region && { region }) }, options.fetch ? { fetch: options.fetch } : {});
}
