import { parseFrontMatter, parseVersion } from '@shipcast/schema';
import { projectSlug } from './drafts.ts';
import type { GitHubSource } from './github.ts';
import type { Repositories } from './repositories/index.ts';

/*
 * What a release is compared with to choose its pack (docs/launch-yml.md, "Which pack a release
 * gets"). The registry alone was not enough: Action mode starts with an empty one on the launches
 * repo's state branch, and a project announced by hand or as an article never has a published
 * release launch in it, so Sluice v0.10.1 was drafted as a first `launch` and reintroduced a project
 * the blog had covered four days earlier (2026-11-02). Each source below is asked only when the ones
 * before it found nothing, so a release the registry knows costs no extra call.
 */

/** The ref an earlier announcement of a project had no version for: enough to say it is not the first */
export const ANNOUNCED_WITHOUT_VERSION = 'announced';

/** Posts read for their front matter at most, per claim; the slug filter keeps it to a few */
const MAX_POSTS_READ = 20;

export interface LaunchHistoryDeps {
  github: GitHubSource;
  registry: Pick<Repositories, 'launches'>;
  /** The launches repo, whose earlier launches and articles count; without it only the registry and the releases do */
  launchesRepo?: string | undefined;
}

/**
 * The ref of the project's last announcement before `tag`, or undefined when this is its first: in
 * order, the registry's last published launch of the repo, an earlier launch in the launches repo
 * (a `launches/<project>/<ref>/` folder, or a blog post whose front matter names the repo, with its
 * `version`), then an earlier published release of the project. A project with an earlier release
 * is not being launched for the first time, whether or not that release was announced.
 */
export async function previousLaunchRef(repo: string, tag: string, deps: LaunchHistoryDeps): Promise<string | undefined> {
  const published = await deps.registry.launches.lastPublishedRef(repo);
  if (published) return published;

  let announcedWithoutVersion = false;
  if (deps.launchesRepo && deps.github.filesUnder) {
    const announced = await quietly(() => announcedRefs(repo, deps.launchesRepo!, deps.github));
    const before = previousOf(tag, announced?.refs ?? []);
    if (before) return before;
    announcedWithoutVersion = announced?.withoutVersion ?? false;
  }

  if (deps.github.releases) {
    const releases = (await quietly(() => deps.github.releases!(repo))) ?? [];
    const before = previousOf(
      tag,
      releases.filter((r) => !r.prerelease).map((r) => r.tag),
    );
    if (before) return before;
  }
  return announcedWithoutVersion ? ANNOUNCED_WITHOUT_VERSION : undefined;
}

/** The refs the launches repo shows the project was announced at, and whether a post named it with no version */
async function announcedRefs(repo: string, launchesRepo: string, github: GitHubSource): Promise<{ refs: string[]; withoutVersion: boolean }> {
  const slug = projectSlug(repo);
  const refs = new Set<string>();
  // A launch's folder exists on the default branch once its drafts pull request was merged
  for (const path of await github.filesUnder!(launchesRepo, 'HEAD', `launches/${slug}`)) {
    const ref = path.split('/')[2];
    if (ref && path.split('/').length > 3) refs.add(ref);
  }
  // An article written by hand or in the app has no launch folder, but its post names the repo
  const posts = (await github.filesUnder!(launchesRepo, 'HEAD', 'src/content/posts'))
    .filter((p) => p.endsWith('.md') && (p.split('/').at(-1) ?? '').toLowerCase().includes(slug))
    .slice(0, MAX_POSTS_READ);
  const url = `https://github.com/${repo}`.toLowerCase();
  let withoutVersion = false;
  for (const path of posts) {
    const text = await github.fileAt(launchesRepo, path, 'HEAD');
    if (!text) continue;
    const { data } = parseFrontMatter(text);
    const named = typeof data.repo === 'string' ? data.repo.trim().replace(/\/+$/, '').toLowerCase() : '';
    if (named !== url && named !== repo.toLowerCase()) continue;
    if (typeof data.version === 'string' && data.version.trim()) refs.add(data.version.trim());
    else withoutVersion = true;
  }
  return { refs: [...refs], withoutVersion };
}

/**
 * The ref `tag` follows among `refs`: the highest version below it, else (no version below it, or
 * refs that are not versions) any other ref, which still says the project was announced before.
 */
export function previousOf(tag: string, refs: readonly string[]): string | undefined {
  const others = refs.filter((r) => r !== tag);
  if (others.length === 0) return undefined;
  const now = parseVersion(tag);
  if (now) {
    const below = others
      .map((ref) => ({ ref, v: parseVersion(ref) }))
      .filter((x): x is { ref: string; v: NonNullable<typeof now> } => x.v !== null && compare(x.v, now) < 0)
      .sort((a, b) => compare(b.v, a.v));
    if (below[0]) return below[0].ref;
  }
  return others[0];
}

function compare(a: { major: number; minor: number; patch: number }, b: { major: number; minor: number; patch: number }): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/** A lookup that fails tells nothing: the next source is asked, as when it found nothing */
async function quietly<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch {
    return undefined;
  }
}
