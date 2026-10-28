import { ConfigError } from '../config.ts';

/*
 * When a copy of Shipcast talks to fake networks (SHIPCAST_PREVIEW_FAKE_NETWORKS=1), and the rule
 * that keeps the switch out of production and a preview off the real networks.
 *
 * - On the owner's machine a preview serves plain HTTP (SHIPCAST_APP_TLS=off), which production
 *   never does.
 * - On a server a preview sits behind Traefik like production (SHIPCAST_APP_TLS=proxy), so TLS no
 *   longer tells them apart: there the switch also needs the preview's own throwaway database, whose
 *   name ends in `_preview`. A stray switch in production's environment does nothing, and production's
 *   pieces are never answered by a fake.
 * - The other way round, a database named as a preview's never runs without the switch
 *   (assertPreviewSafe): a preview whose environment lost it stops instead of reaching a network.
 */

/** The database a URL names, decoded; undefined when it is not a URL */
function databaseName(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  } catch {
    return undefined;
  }
}

/** Whether a database URL names a preview's throwaway database (`…_preview`) */
export function previewDatabase(url: string | undefined): boolean {
  return /_preview$/.test(databaseName(url) ?? '');
}

/** Whether this process is a preview with fake networks */
export function fakeNetworks(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.SHIPCAST_PREVIEW_FAKE_NETWORKS !== '1') return false;
  if (env.SHIPCAST_APP_TLS === 'off') return true;
  return env.SHIPCAST_APP_TLS === 'proxy' && previewDatabase(env.SHIPCAST_DATABASE_URL);
}

/** Stops a process on a preview's database that would reach the real networks */
export function assertPreviewSafe(env: NodeJS.ProcessEnv = process.env): void {
  const preview = previewDatabase(env.SHIPCAST_DATABASE_URL) || previewDatabase(env.SHIPCAST_DATABASE_MIGRATE_URL);
  if (preview && !fakeNetworks(env)) {
    throw new ConfigError('this is a preview database (its name ends in _preview): it only runs with SHIPCAST_PREVIEW_FAKE_NETWORKS=1 and SHIPCAST_APP_TLS=proxy or off, so nothing it does reaches a real network');
  }
  if (fakeNetworks(env) && env.SHIPCAST_DATABASE_MIGRATE_URL && !previewDatabase(env.SHIPCAST_DATABASE_MIGRATE_URL) && env.SHIPCAST_APP_TLS === 'proxy') {
    throw new ConfigError('a preview with fake networks migrates its own database: SHIPCAST_DATABASE_MIGRATE_URL must name a …_preview database too');
  }
}
