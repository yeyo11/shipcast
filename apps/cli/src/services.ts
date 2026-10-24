import { readFileSync } from 'node:fs';
import { Bluesky, CloudflareAnalytics, Devto, Instagram, Mastodon, SearchConsole, type ServiceAccount } from '@shipcast/connectors';
import type { GitHubRest, MetricSources, Publishers, Registry } from '@shipcast/engine';
import type { Brand } from '@shipcast/schema';

/** Where a refreshed Instagram token is kept: in the registry, beside the launches, never in a file in the repo. */
export const INSTAGRAM_TOKEN_KEY = 'instagram-token';
export const INSTAGRAM_REFRESHED_KEY = 'instagram-token-refreshed-at';

/** `https://bsky.app/profile/yeyo11.bsky.social` → `yeyo11.bsky.social` */
export function blueskyHandle(profile: string | undefined): string | undefined {
  return profile ? /\/profile\/([^/?#]+)/.exec(profile)?.[1] : undefined;
}

/** `https://mastodon.social/@yeyo11` → `https://mastodon.social` */
export function mastodonInstance(profile: string | undefined): string | undefined {
  return profile ? new URL(profile).origin : undefined;
}

export interface Services {
  publishers: Publishers;
  sources: MetricSources;
  instagram: Instagram | undefined;
  /** Which channels and sources have credentials, for `shipcast status` and the first run */
  configured: string[];
}

/**
 * The connectors for which credentials exist: a network without them is left out (and reported),
 * never half-configured. Public values (handles, instance) come from brand.yml; secrets from .env.
 */
export function buildServices(env: NodeJS.ProcessEnv, brand: Brand, registry: Registry, github: GitHubRest): Services {
  const publishers: Publishers = {};
  const posts: NonNullable<MetricSources['posts']> = {};
  const configured: string[] = [];

  if (env.DEVTO_API_KEY) {
    const devto = new Devto({ apiKey: env.DEVTO_API_KEY });
    publishers.devto = devto;
    posts.devto = devto;
    configured.push('devto');
  }
  const handle = env.BLUESKY_HANDLE || blueskyHandle(brand.handles.bluesky);
  if (handle && env.BLUESKY_APP_PASSWORD) {
    const bluesky = new Bluesky({ identifier: handle, appPassword: env.BLUESKY_APP_PASSWORD });
    publishers.bluesky = bluesky;
    posts.bluesky = bluesky;
    configured.push('bluesky');
  }
  const instance = env.MASTODON_INSTANCE || mastodonInstance(brand.handles.mastodon);
  if (instance && env.MASTODON_ACCESS_TOKEN) {
    const mastodon = new Mastodon({ instance, accessToken: env.MASTODON_ACCESS_TOKEN });
    publishers.mastodon = mastodon;
    posts.mastodon = mastodon;
    configured.push('mastodon');
  }
  let instagram: Instagram | undefined;
  const instagramToken = registry.cursor(INSTAGRAM_TOKEN_KEY) ?? env.INSTAGRAM_ACCESS_TOKEN;
  if (env.INSTAGRAM_USER_ID && instagramToken) {
    instagram = new Instagram({ userId: env.INSTAGRAM_USER_ID, accessToken: instagramToken });
    publishers.instagram = instagram;
    posts.instagram = instagram;
    configured.push('instagram');
  }

  const sources: MetricSources = { posts, github };
  configured.push('github');
  if (env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_WEB_ANALYTICS_SITE_TAG) {
    sources.blog = new CloudflareAnalytics({
      apiToken: env.CLOUDFLARE_API_TOKEN,
      accountId: env.CLOUDFLARE_ACCOUNT_ID,
      siteTag: env.CLOUDFLARE_WEB_ANALYTICS_SITE_TAG,
    });
    configured.push('blog analytics');
  }
  if (env.GOOGLE_SERVICE_ACCOUNT_FILE) {
    const account = JSON.parse(readFileSync(env.GOOGLE_SERVICE_ACCOUNT_FILE, 'utf8')) as ServiceAccount;
    sources.search = new SearchConsole({ serviceAccount: account, property: `sc-domain:${new URL(brand.site).host}` });
    configured.push('search console');
  }
  return { publishers, sources, instagram, configured };
}

/**
 * Refreshes the Instagram token every 30 days (it lasts 60), keeping the fresh one in the registry.
 * Meta refuses to refresh a token younger than 24 hours, so a first run only records the date.
 */
export async function refreshInstagramToken(services: Services, registry: Registry, now = new Date()): Promise<string | undefined> {
  if (!services.instagram) return undefined;
  const last = registry.cursor(INSTAGRAM_REFRESHED_KEY);
  if (!last) {
    registry.setCursor(INSTAGRAM_REFRESHED_KEY, now.toISOString());
    return undefined;
  }
  if (now.getTime() - Date.parse(last) < 30 * 24 * 3600 * 1000) return undefined;
  const fresh = await services.instagram.refreshToken();
  registry.setCursor(INSTAGRAM_TOKEN_KEY, fresh.accessToken);
  registry.setCursor(INSTAGRAM_REFRESHED_KEY, now.toISOString());
  return `Instagram token refreshed; valid for ${Math.round(fresh.expiresIn / 86400)} more days`;
}
