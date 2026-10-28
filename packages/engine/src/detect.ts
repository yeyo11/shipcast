import { formatIssues, parseLaunchConfig, resolvePack, type Brand } from '@shipcast/schema';
import type { GitHubEvent, GitHubSource } from './github.ts';
import type { Launch, Registry } from './registry.ts';

export const LAUNCH_CONFIG_PATH = '.github/launch.yml';

/** What became of one event. Only `claimed` starts any work. */
export type Outcome =
  | { event: GitHubEvent; result: 'claimed'; launch: Launch }
  | { event: GitHubEvent; result: 'already-claimed'; launch: Launch }
  | { event: GitHubEvent; result: 'invalid-config'; launch: Launch }
  | { event: GitHubEvent; result: 'ignored'; reason: string };

export interface DetectOptions {
  github: GitHubSource;
  registry: Registry;
  /** The brand of the launches repo this engine writes to; launches for any other are refused */
  brand: Brand;
}

/**
 * Reads the brand's GitHub account's new public events and claims a launch for each release (or
 * repo made public) whose `.github/launch.yml` asks for it. Events already seen are skipped through
 * the last event id, and the request itself is conditional, so polling often is free.
 */
export async function detect({ github, registry, brand }: DetectOptions): Promise<Outcome[]> {
  const owner = brand.github;
  const etagKey = `events-etag:${owner}`;
  const lastKey = `events-last-id:${owner}`;

  const page = await github.userEvents(owner, await registry.cursors.cursor(etagKey));
  if (page.notModified) return [];

  const lastSeen = BigInt((await registry.cursors.cursor(lastKey)) ?? '0');
  // Oldest first, so launches are claimed in the order they happened
  const fresh = page.events.filter((e) => BigInt(e.id) > lastSeen).reverse();

  const outcomes: Outcome[] = [];
  for (const event of fresh) {
    outcomes.push(await claimEvent(event, { github, registry, brand }));
    // Advanced per event, so a crash halfway through resumes where it stopped
    await registry.cursors.setCursor(lastKey, event.id);
  }
  if (page.etag) await registry.cursors.setCursor(etagKey, page.etag);
  return outcomes;
}

/**
 * Decides one event: the same rules whether it came from polling the events or from a GitHub webhook,
 * so a release is launched (or ignored) for the same reasons either way, and claimed only once.
 */
export async function claimEvent(event: GitHubEvent, { github, registry, brand }: DetectOptions): Promise<Outcome> {
  if (event.type === 'release' && event.prerelease) return { event, result: 'ignored', reason: 'a pre-release' };

  // A repo made public has no tag: its launch reads the default branch and is keyed by the event
  const ref = event.type === 'release' ? event.tag : 'HEAD';
  const text = await github.fileAt(event.repo, LAUNCH_CONFIG_PATH, ref);
  if (text === undefined) return { event, result: 'ignored', reason: `no ${LAUNCH_CONFIG_PATH}` };

  const key = event.type === 'release' ? event.tag : `public:${event.id}`;
  const parsed = parseLaunchConfig(text);
  if (!parsed.ok) {
    // Recorded as failed so the owner hears about it, and so it is not retried on every poll
    const claim = await registry.launches.claim({ repo: event.repo, ref: key, trigger: triggerOf(event), kind: 'minor', brand: brand.id });
    if (claim.claimed) {
      await registry.launches.setStatus(claim.launch.id, 'failed', formatIssues(LAUNCH_CONFIG_PATH, parsed.issues));
    }
    return { event, result: 'invalid-config', launch: (await registry.launches.get(claim.launch.id))! };
  }

  const config = parsed.value;
  if (!config.enabled) return { event, result: 'ignored', reason: 'launch.yml has enabled: false' };
  if (event.type === 'release' && !config.triggers.release) {
    return { event, result: 'ignored', reason: 'releases do not trigger launches in this repo' };
  }
  if (event.type === 'public' && !config.triggers.public) {
    return { event, result: 'ignored', reason: 'going public does not trigger a launch in this repo' };
  }
  if (config.brand !== brand.id) {
    return { event, result: 'ignored', reason: `launch.yml names brand "${config.brand}", not "${brand.id}"` };
  }

  const kind =
    event.type === 'public' ? (config.pack ?? 'launch') : resolvePack(config, event.tag, await registry.launches.lastPublishedRef(event.repo));
  const claim = await registry.launches.claim({ repo: event.repo, ref: key, trigger: triggerOf(event), kind, brand: brand.id });
  return claim.claimed
    ? { event, result: 'claimed', launch: claim.launch }
    : { event, result: 'already-claimed', launch: claim.launch };
}

function triggerOf(event: GitHubEvent): 'release' | 'public' {
  return event.type;
}
