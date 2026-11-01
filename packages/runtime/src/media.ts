import { R2MediaStore, unavailableMediaStore, type MediaStore } from '@shipcast/engine';
import { ConfigError, loadMediaStoreConfig, MEDIA_STORE_VARIABLES } from './config.ts';
import { fakeNetworks } from './preview/guard.ts';
import { PreviewMediaStore } from './preview/media.ts';

/**
 * The process's media store (docs/media-store.md): R2 from SHIPCAST_MEDIA_* in .env. Every launch is
 * held by Shipcast and keeps its files there, so a server (SHIPCAST_APP_TLS=proxy, as production
 * runs) does not start without it. A desktop install or a preview with fake networks may run
 * without one: the store then refuses every call saying what is missing, so a launch with files
 * fails its draft with the reason instead of losing them.
 */
export function mediaStoreFor(env: NodeJS.ProcessEnv, options: { fetch?: typeof fetch } = {}): MediaStore {
  const config = loadMediaStoreConfig(env);
  if (!config) {
    const missing = `missing in .env: ${MEDIA_STORE_VARIABLES.join(', ')} (see .env.example)`;
    if (env.SHIPCAST_APP_TLS === 'proxy' && !fakeNetworks(env)) throw new ConfigError(`the media store is required on a server: ${missing}`);
    // A local preview with fake networks keeps its uploads in memory, so the editor's images can be tried there
    if (env.SHIPCAST_APP_TLS === 'off' && fakeNetworks(env)) return new PreviewMediaStore();
    return unavailableMediaStore(missing);
  }
  const { region, ...bucket } = config;
  return new R2MediaStore({ ...bucket, ...(region && { region }) }, options.fetch ? { fetch: options.fetch } : {});
}
