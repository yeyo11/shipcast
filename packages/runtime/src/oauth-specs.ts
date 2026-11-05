import type { NetworkSpec, OAuthSpec, OAuthVariants } from './channels/adapter.ts';
import type { SettingsValues } from './settings.ts';

/*
 * Which sign-in a network uses. Most have one spec; one whose sign-in depends on how the owner's app
 * is set up (Instagram) has variants, and Settings says which.
 */

export function isVariants(oauth: OAuthSpec | OAuthVariants): oauth is OAuthVariants {
  return 'variants' in oauth;
}

/**
 * The variant the settings name (unknown or unset: `fallback`), or the one spec; undefined without
 * oauth. A callback passes the variant its flow started with, so a setting changed in between does
 * not finish one sign-in with another's spec.
 */
export function oauthSpecOf(network: NetworkSpec, settings: SettingsValues, variant?: string): { spec: OAuthSpec; variant: string | undefined } | undefined {
  const oauth = network.oauth;
  if (!oauth) return undefined;
  if (!isVariants(oauth)) return { spec: oauth, variant: undefined };
  const wanted = variant ?? settings[oauth.setting];
  const name = wanted !== undefined && Object.hasOwn(oauth.variants, wanted) ? wanted : oauth.fallback;
  const spec = oauth.variants[name];
  return spec ? { spec, variant: name } : undefined;
}

/** Every spec a network may sign in with, for deriving the app settings */
export function oauthSpecsOf(network: NetworkSpec): OAuthSpec[] {
  const oauth = network.oauth;
  if (!oauth) return [];
  return isVariants(oauth) ? Object.values(oauth.variants) : [oauth];
}
