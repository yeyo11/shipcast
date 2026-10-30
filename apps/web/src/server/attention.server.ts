import { CANONICAL_PREFIX, failurePrefix, LAUNCH_STORE_PREFIX, METRIC_PROBLEM_PREFIX, type CanonicalMismatch, type Repositories } from '@shipcast/engine';
import { attentionItems, buildAttention, type Attention, type AttentionInput } from './attention.ts';

type AttentionRegistry = Pick<Repositories, 'launches' | 'cursors' | 'accounts' | 'comments' | 'posts' | 'attention'>;

/**
 * A canonical cursor's pages; none for a value that does not parse as a list. One bad row (written by
 * hand, or by an older version) must not take the whole bell down with it.
 */
function pagesOf(value: string): CanonicalMismatch[] {
  try {
    const pages: unknown = JSON.parse(value);
    return Array.isArray(pages) ? pages.filter((p): p is CanonicalMismatch => typeof p?.url === 'string' && typeof p?.googleCanonical === 'string') : [];
  } catch {
    return [];
  }
}

/** A launch-store cursor's differences; none for a value that does not parse, as for the canonicals */
function differencesOf(value: string): string[] {
  try {
    const report: unknown = JSON.parse(value);
    const differences: unknown = report && typeof report === 'object' && 'differences' in report ? report.differences : undefined;
    return Array.isArray(differences) ? differences.filter((d): d is string => typeof d === 'string') : [];
  } catch {
    return [];
  }
}

/** What this process runs with that changes what the bell reads */
export interface AttentionOptions {
  /** The shadow write (`launch-store`) is on: only it writes the cursors whose differences the bell shows */
  launchStore?: boolean;
}

async function readInput(registry: AttentionRegistry, options: AttentionOptions): Promise<AttentionInput> {
  const [launches, failures, metricProblems, accounts, facets, newest, scheduled, canonicals, stored] = await Promise.all([
    registry.launches.recent(60),
    registry.cursors.cursorsWithPrefix(failurePrefix()),
    registry.cursors.cursorsWithPrefix(METRIC_PROBLEM_PREFIX),
    registry.accounts.accounts(),
    registry.comments.commentFacets(false),
    registry.comments.newestWaitingCommentId(false),
    registry.posts.scheduledPosts(),
    registry.cursors.cursorsWithPrefix(CANONICAL_PREFIX),
    // Every page asks for the bell: with the flag off, the query is not made at all
    options.launchStore ? registry.cursors.cursorsWithPrefix(LAUNCH_STORE_PREFIX) : Promise.resolve([]),
  ]);
  return {
    launches: launches.map((l) => ({ id: l.id, repo: l.repo, ref: l.ref, status: l.status, updatedAt: l.updatedAt })),
    failures,
    brokenAccounts: accounts.filter((a) => a.status === 'failed').map((a) => ({ id: a.id, label: a.label, network: a.network, problem: a.problem })),
    commentsWaiting: facets.buckets.waiting,
    newestWaitingComment: newest,
    scheduled: scheduled.map((p) => ({ launchId: p.launchId, scheduledAt: p.scheduledAt })),
    metricProblems,
    canonicals: canonicals.map(({ key, value }) => ({ launchId: Number(key.slice(CANONICAL_PREFIX.length)), pages: pagesOf(value) })),
    storeDifferences: stored.map(({ key, value }) => ({ launchId: Number(key.slice(LAUNCH_STORE_PREFIX.length)), differences: differencesOf(value) })),
    now: new Date(),
  };
}

/**
 * The bell's list: what waits for the owner across launches, comments and accounts, less what the
 * owner dismissed. One round of small queries whatever the number of launches (the failure cursors
 * are read by prefix for all launches at once, the comments as grouped counts), never one per launch.
 * The dismissals of lines no longer there are forgotten here, so a condition that comes back after
 * it ended is shown again (see attention.ts).
 */
export async function attentionFor(registry: AttentionRegistry, options: AttentionOptions = {}): Promise<Attention> {
  const input = await readInput(registry, options);
  const keys = attentionItems(input).map((i) => i.key);
  await registry.attention.clearAttentionDismissals(keys);
  return buildAttention({ ...input, dismissed: await registry.attention.dismissedAttention(keys) });
}
