import type { LaunchConfig, PackKind } from './launch-config.ts';

interface Semver {
  major: number;
  minor: number;
  patch: number;
}

/** `v1.2.3`, `1.2.3-beta.1` → { 1, 2, 3 }; anything that is not a version → null. */
export function parseVersion(tag: string): Semver | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(tag.trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/**
 * The pack a release gets when launch.yml does not force one: the first launch of a project is a
 * `launch`, a new major version is `major`, everything else `minor`. Before 1.0 a minor bump is the
 * breaking one (semver's own rule for 0.y.z), so 0.8 → 0.9 is `major` and 0.8.0 → 0.8.1 is `minor`.
 * A tag that is not semver gets `minor`: the quiet choice, rather than a campaign on a guess.
 */
export function inferPack(version: string | undefined, previous: string | undefined): PackKind {
  if (!previous) return 'launch';
  const now = version ? parseVersion(version) : null;
  const before = parseVersion(previous);
  if (!now || !before) return 'minor';
  if (now.major > before.major) return 'major';
  if (now.major === 0 && before.major === 0 && now.minor > before.minor) return 'major';
  return 'minor';
}

/** launch.yml's `pack` wins; otherwise inferPack. */
export function resolvePack(config: LaunchConfig, version: string | undefined, previous: string | undefined): PackKind {
  return config.pack ?? inferPack(version, previous);
}
