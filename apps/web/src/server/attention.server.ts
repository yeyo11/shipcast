import { CANONICAL_PREFIX, failurePrefix, METRIC_PROBLEM_PREFIX, type CanonicalMismatch, type Repositories } from '@shipcast/engine';
import { attentionItems, buildAttention, type Attention, type AttentionInput } from './attention.ts';

type AttentionRegistry = Pick<Repositories, 'launches' | 'cursors' | 'accounts' | 'comments' | 'posts' | 'attention'>;

async function readInput(registry: AttentionRegistry): Promise<AttentionInput> {
  const [launches, failures, metricProblems, accounts, facets, newest, scheduled, canonicals] = await Promise.all([
    registry.launches.recent(60),
    registry.cursors.cursorsWithPrefix(failurePrefix()),
    registry.cursors.cursorsWithPrefix(METRIC_PROBLEM_PREFIX),
    registry.accounts.accounts(),
    registry.comments.commentFacets(false),
    registry.comments.newestWaitingCommentId(false),
    registry.posts.scheduledPosts(),
    registry.cursors.cursorsWithPrefix(CANONICAL_PREFIX),
  ]);
  return {
    launches: launches.map((l) => ({ id: l.id, repo: l.repo, ref: l.ref, status: l.status, updatedAt: l.updatedAt })),
    failures,
    brokenAccounts: accounts.filter((a) => a.status === 'failed').map((a) => ({ id: a.id, label: a.label, network: a.network, problem: a.problem })),
    commentsWaiting: facets.buckets.waiting,
    newestWaitingComment: newest,
    scheduled: scheduled.map((p) => ({ launchId: p.launchId, scheduledAt: p.scheduledAt })),
    metricProblems,
    canonicals: canonicals.map(({ key, value }) => ({ launchId: Number(key.slice(CANONICAL_PREFIX.length)), pages: JSON.parse(value) as CanonicalMismatch[] })),
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
export async function attentionFor(registry: AttentionRegistry): Promise<Attention> {
  const input = await readInput(registry);
  const keys = attentionItems(input).map((i) => i.key);
  await registry.attention.clearAttentionDismissals(keys);
  return buildAttention({ ...input, dismissed: await registry.attention.dismissedAttention(keys) });
}
