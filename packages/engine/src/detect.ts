import { formatIssues, matchingRule, parseLaunchConfig, resolvePack, type Brand, type PackKind } from '@shipcast/schema';
import type { GitHubEvent, GitHubSource } from './github.ts';
import { dedupeKeyOf, ruleLaunchYml } from './launch-keys.ts';
import type { Launch, Repositories } from './repositories/index.ts';
import type { TriggerService } from './services/triggers.ts';

export const LAUNCH_CONFIG_PATH = '.github/launch.yml';

/** What became of one event. Only `claimed` starts any work. */
export type Outcome =
  | { event: GitHubEvent; result: 'claimed'; launch: Launch }
  | { event: GitHubEvent; result: 'already-claimed'; launch: Launch }
  | { event: GitHubEvent; result: 'invalid-config'; launch: Launch }
  | { event: GitHubEvent; result: 'ignored'; reason: string };

export interface DetectOptions {
  github: GitHubSource;
  registry: Pick<Repositories, 'launches' | 'cursors'>;
  /** The brand of the launches repo this engine writes to; launches for any other are refused */
  brand: Brand;
  /**
   * With `launch-triggers`: the owner's trigger rules decide which events create a launch, a repo
   * with no launch.yml is launched on a rule's channels. Each claim carries its dedupe key either way
   */
  triggers?: Pick<TriggerService, 'rules' | 'claimKeeping'> | undefined;
  /** With `launch-delete`: whether the owner removed the launch a dedupe key names; its events launch nothing again */
  removed?: ((dedupeKey: string) => Promise<boolean>) | undefined;
}

/**
 * Reads the brand's GitHub account's new public events and claims a launch for each release (or
 * repo made public) whose `.github/launch.yml` asks for it. Events already seen are skipped through
 * the last event id, and the request itself is conditional, so polling often is free.
 */
export async function detect(options: DetectOptions): Promise<Outcome[]> {
  const { github, registry } = options;
  const owner = options.brand.github;
  const etagKey = `events-etag:${owner}`;
  const lastKey = `events-last-id:${owner}`;

  const page = await github.userEvents(owner, await registry.cursors.cursor(etagKey));
  if (page.notModified) return [];

  const lastSeen = BigInt((await registry.cursors.cursor(lastKey)) ?? '0');
  // Oldest first, so launches are claimed in the order they happened
  const fresh = page.events.filter((e) => BigInt(e.id) > lastSeen).reverse();

  const outcomes: Outcome[] = [];
  for (const event of fresh) {
    outcomes.push(await claimEvent(event, options));
    // Advanced per event, so a crash halfway through resumes where it stopped
    await registry.cursors.setCursor(lastKey, event.id);
  }
  if (page.etag) await registry.cursors.setCursor(etagKey, page.etag);
  return outcomes;
}

/**
 * Decides one event: the same rules whether it came from polling the events or from a GitHub webhook,
 * so a release is launched (or ignored) for the same reasons either way, and claimed only once. With
 * `triggers` the owner's rules decide which events count and launch.yml is optional input
 * (docs/launch-triggers.md); without, the repo's launch.yml decides alone, as it always did.
 */
export async function claimEvent(event: GitHubEvent, options: DetectOptions): Promise<Outcome> {
  const { github, registry, brand } = options;
  const prerelease = event.type === 'release' && event.prerelease;
  const rule = options.triggers ? matchingRule(await options.triggers.rules(), { type: event.type, repo: event.repo, prerelease }) : undefined;
  if (options.triggers && !rule) return { event, result: 'ignored', reason: prerelease ? 'a pre-release, which no trigger rule takes' : 'no trigger rule matches' };
  if (!options.triggers && prerelease) return { event, result: 'ignored', reason: 'a pre-release' };

  // A repo made public has no tag: its launch reads the default branch and is keyed by the event
  const ref = event.type === 'release' ? event.tag : 'HEAD';
  const key = event.type === 'release' ? event.tag : `public:${event.id}`;
  // The same release (or the same repo made public, by webhook and by poll) is one key, so it is claimed once
  const dedupeKey = dedupeKeyOf({ repo: event.repo, ref: key });
  if (options.removed && (await options.removed(dedupeKey))) return { event, result: 'ignored', reason: 'its launch was deleted' };
  const newLaunch = (kind: PackKind) => ({ repo: event.repo, ref: key, trigger: triggerOf(event), kind, brand: brand.id, dedupeKey });
  const claim = (kind: PackKind) => registry.launches.claim(newLaunch(kind));

  const text = await github.fileAt(event.repo, LAUNCH_CONFIG_PATH, ref);
  // A rule that names channels launches a repo with no launch.yml on them; the launch keeps them as its own
  const kept = text === undefined && rule?.channels ? ruleLaunchYml(brand, rule.channels) : undefined;
  const config = text ?? kept;
  if (config === undefined) {
    return { event, result: 'ignored', reason: rule ? `no ${LAUNCH_CONFIG_PATH}, and the rule "${rule.id}" launches only repos with one` : `no ${LAUNCH_CONFIG_PATH}` };
  }

  const parsed = parseLaunchConfig(config);
  if (!parsed.ok) {
    // Recorded as failed so the owner hears about it, and so it is not retried on every poll
    const claimed = await claim('minor');
    if (claimed.claimed) {
      await registry.launches.setStatus(claimed.launch.id, 'failed', formatIssues(LAUNCH_CONFIG_PATH, parsed.issues));
    }
    return { event, result: 'invalid-config', launch: (await registry.launches.get(claimed.launch.id))! };
  }

  const { value } = parsed;
  if (!value.enabled) return { event, result: 'ignored', reason: 'launch.yml has enabled: false' };
  // A repo's own launch.yml still says no for itself, whatever a rule takes
  if (event.type === 'release' && !value.triggers.release) {
    return { event, result: 'ignored', reason: 'releases do not trigger launches in this repo' };
  }
  if (event.type === 'public' && !kept && !value.triggers.public) {
    return { event, result: 'ignored', reason: 'going public does not trigger a launch in this repo' };
  }
  if (value.brand !== brand.id) {
    return { event, result: 'ignored', reason: `launch.yml names brand "${value.brand}", not "${brand.id}"` };
  }

  const kind =
    event.type === 'public' ? (value.pack ?? 'launch') : resolvePack(value, event.tag, await registry.launches.lastPublishedRef(event.repo));
  let claimed: { claimed: boolean; launch: Launch };
  if (kept && options.triggers && rule) {
    try {
      claimed = await options.triggers.claimKeeping(newLaunch(kind), kept);
    } catch (error) {
      // Rolled back whole: recorded as failed on its own, so the owner hears of it and it is not retried on every poll
      const failed = await claim(kind);
      if (!failed.claimed) return { event, result: 'already-claimed', launch: failed.launch };
      const launch = await registry.launches.setStatus(failed.launch.id, 'failed', `the channels of the rule "${rule.id}" could not be kept: ${error instanceof Error ? error.message : String(error)}`);
      return { event, result: 'invalid-config', launch };
    }
  } else claimed = await claim(kind);
  return claimed.claimed
    ? { event, result: 'claimed', launch: claimed.launch }
    : { event, result: 'already-claimed', launch: claimed.launch };
}

function triggerOf(event: GitHubEvent): 'release' | 'public' {
  return event.type;
}
