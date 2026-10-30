import { CHANNELS, type Brand, type Channel } from '@shipcast/schema';
import { stringify } from 'yaml';

/*
 * What a launch is known by and the launch.yml a trigger rule stands in for: small pure helpers that
 * core detection (detect.ts), the repositories and the services all need. Kept apart from the
 * services and the import so the claim of an event depends on nothing above it.
 */

/**
 * What "a launch happens once" is checked on once there is no repo and tag to claim
 * (`launches.dedupe_key`): the release a launch announced, the repo that went public, the article.
 * Migration 0021 backfills the same keys in SQL: a change here must change it there too.
 */
export function dedupeKeyOf(launch: { repo: string; ref: string }): string {
  if (launch.ref.startsWith('article:')) return `article:${launch.ref.slice('article:'.length)}`;
  if (launch.ref.startsWith('public:')) return `github-public:${launch.repo}`;
  return `github-release:${launch.repo}@${launch.ref}`;
}

/**
 * The launch.yml a rule stands in for when the repo has none: every channel the rule names waits
 * for approval, every other is off. Kept as the launch's channels (`channels_source`), so the draft,
 * the review and publishing read it as they read a repo's own.
 */
export function ruleLaunchYml(brand: Pick<Brand, 'id'>, channels: readonly Channel[]): string {
  const publishing = Object.fromEntries(CHANNELS.map((c) => [c, channels.includes(c) ? 'approval' : 'off']));
  return stringify({ enabled: true, brand: brand.id, publishing });
}
