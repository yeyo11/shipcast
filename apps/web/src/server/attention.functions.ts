import { failurePrefix } from '@shipcast/engine';
import { createServerFn } from '@tanstack/react-start';
import { ATTENTION_KEY, attentionItems, buildAttention, type AttentionInput } from './attention';
import { appContext } from './context.server';
import { InvalidInput, list, object } from './input';

/** More than the bell ever lists at once; a longer list is not a click on it */
const MAX_KEYS = 100;

async function readInput(): Promise<AttentionInput> {
  const { registry } = await appContext();
  const [launches, failures, accounts, facets, newest, scheduled] = await Promise.all([
    registry.launches.recent(60),
    registry.cursors.cursorsWithPrefix(failurePrefix()),
    registry.accounts.accounts(),
    registry.comments.commentFacets(false),
    registry.comments.newestWaitingCommentId(false),
    registry.posts.scheduledPosts(),
  ]);
  return {
    launches: launches.map((l) => ({ id: l.id, repo: l.repo, ref: l.ref, status: l.status, updatedAt: l.updatedAt })),
    failures,
    brokenAccounts: accounts.filter((a) => a.status === 'failed').map((a) => ({ id: a.id, label: a.label, network: a.network, problem: a.problem })),
    commentsWaiting: facets.buckets.waiting,
    newestWaitingComment: newest,
    scheduled: scheduled.map((p) => ({ launchId: p.launchId, scheduledAt: p.scheduledAt })),
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
export const getAttention = createServerFn({ method: 'GET' }).handler(async () => {
  const { registry } = await appContext();
  const input = await readInput();
  const keys = attentionItems(input).map((i) => i.key);
  await registry.clearAttentionDismissals(keys);
  return buildAttention({ ...input, dismissed: await registry.dismissedAttention(keys) });
});

function keysInput(input: unknown): { keys: string[] } {
  const keys = list(object(input, 'input').keys, 'keys');
  if (keys.length === 0 || keys.length > MAX_KEYS) throw new InvalidInput(`keys must hold 1 to ${MAX_KEYS} keys`);
  for (const key of keys) if (!ATTENTION_KEY.test(key)) throw new InvalidInput(`${key} is not a line of the bell`);
  return { keys };
}

/** Hides one line (or a few) of the bell, on every device, until its condition changes */
export const dismissAttention = createServerFn({ method: 'POST' })
  .validator(keysInput)
  .handler(async ({ data }) => {
    const { registry } = await appContext();
    await registry.dismissAttention(data.keys);
    return { dismissed: data.keys.length };
  });

/**
 * "Clear all": the lines the owner saw, not whatever the bell holds by the time the click lands,
 * so a failure that arrived in between is not cleared unread
 */
export const clearAttention = createServerFn({ method: 'POST' })
  .validator(keysInput)
  .handler(async ({ data }) => {
    const { registry } = await appContext();
    await registry.dismissAttention(data.keys);
    return { dismissed: data.keys.length };
  });
