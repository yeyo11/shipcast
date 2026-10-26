import { createServerFn } from '@tanstack/react-start';
import { buildAttention } from './attention';
import { appContext } from './context.server';

/**
 * The bell's list: what waits for the owner across launches, comments and accounts. One round of
 * five small queries whatever the number of launches (the failure cursors are read by prefix for all
 * launches at once, the comments as one grouped count), never one query per launch.
 */
export const getAttention = createServerFn({ method: 'GET' }).handler(async () => {
  const { registry } = await appContext();
  const [launches, cursors, accounts, facets, scheduled] = await Promise.all([
    registry.recent(60),
    registry.cursorsWithPrefix('publish-failed:'),
    registry.accounts(),
    registry.commentFacets(false),
    registry.scheduledPosts(),
  ]);
  return buildAttention({
    launches: launches.map((l) => ({ id: l.id, repo: l.repo, ref: l.ref, status: l.status })),
    failureKeys: cursors.map((c) => c.key),
    brokenAccounts: accounts.filter((a) => a.status === 'failed').map((a) => ({ id: a.id, label: a.label, network: a.network })),
    commentsWaiting: facets.buckets.waiting,
    scheduled: scheduled.map((p) => ({ launchId: p.launchId, scheduledAt: p.scheduledAt })),
    now: new Date(),
  });
});
