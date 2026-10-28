import { audienceKey, type Account } from '@shipcast/engine';
import { network } from './catalog.ts';
import { MissingField } from './channels/adapter.ts';
import { checkAccountWith, type AccountDeps } from './accounts.ts';

/** How long an account may go without a sync before the Channels page warns: a missed night and a bit */
export const STALE_AFTER_MS = 36 * 3600 * 1000;

/** When an account was last synced: its last snapshot or its last check, whichever is newer */
export function lastSynced(account: Pick<Account, 'checkedAt'>, snapshotAt: string | undefined): string | null {
  const times = [account.checkedAt, snapshotAt].filter((t): t is string => typeof t === 'string');
  return times.sort().at(-1) ?? null;
}

export function isStale(syncedAt: string | null, now = new Date()): boolean {
  return syncedAt === null || now.getTime() - Date.parse(syncedAt) > STALE_AFTER_MS;
}

/** One account's sync, in words for the job's log */
export type SyncResult =
  | { account: Account; outcome: 'recorded'; line: string }
  | { account: Account; outcome: 'checked'; line: string }
  | { account: Account; outcome: 'failed'; line: string };

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Syncs one account: its check again (which keeps the picture fresh, and an Instagram picture's
 * signed address expires), then its numbers, on the networks whose API counts them. A failed check
 * records no numbers: they would be read with a credential that no longer works.
 */
export async function syncAccount(deps: AccountDeps, account: Account, now = new Date()): Promise<SyncResult> {
  const name = `${network(account.network)?.name ?? account.network} ${account.label}`;
  const checked = await checkAccountWith(deps, account, now);
  if (checked.account.status !== 'ok') return { account: checked.account, outcome: 'failed', line: `${name}: ${checked.account.problem ?? 'its check failed'}` };
  const stats = checked.built?.profileStats;
  if (!stats) return { account: checked.account, outcome: 'checked', line: `${name}: checked; its network gives no follower counts` };
  try {
    const snapshot = await deps.registry.recordSnapshot(account.id, await stats(), now);
    const parts = [
      snapshot.followers !== null ? `${snapshot.followers} followers` : null,
      snapshot.following !== null ? `${snapshot.following} following` : null,
      snapshot.posts !== null ? `${snapshot.posts} posts` : null,
    ].filter(Boolean);
    const hours = checked.built?.audienceHours;
    const audience = hours ? await readAudience(deps, account, { audienceHours: hours }, snapshot.followers, now) : undefined;
    return { account: checked.account, outcome: 'recorded', line: `${name}: ${[parts.join(', ') || 'no counts given', audience].filter(Boolean).join('; ')}` };
  } catch (error) {
    return { account: checked.account, outcome: 'failed', line: `${name}: could not read its numbers: ${message(error)}` };
  }
}

/** Meta gives an account's online followers only from 100 followers up */
const AUDIENCE_MIN_FOLLOWERS = 100;

/**
 * The hours an Instagram account's followers are online, kept for the scheduling recommendation.
 * Never fails the sync: the numbers are what it is for, and the hours are a bonus Meta may not give.
 */
async function readAudience(
  deps: AccountDeps,
  account: Account,
  instagram: { audienceHours(): Promise<{ timeZone: string; hours: number[] } | undefined> },
  followers: number | null,
  now: Date,
): Promise<string | undefined> {
  if (followers !== null && followers < AUDIENCE_MIN_FOLLOWERS) return undefined;
  try {
    const audience = await instagram.audienceHours();
    if (!audience) return 'no online-follower hours given';
    await deps.registry.setCursor(audienceKey(account.id), JSON.stringify({ ...audience, takenAt: now.toISOString() }));
    return 'online-follower hours read';
  } catch (error) {
    return `online-follower hours not read: ${message(error)}`;
  }
}

/**
 * The daily snapshot of every connected account, or of one (Sync now). One account failing never
 * stops the others; an account of a brand Shipcast no longer has is left alone.
 */
export async function takeSnapshots(deps: AccountDeps, options: { accountId?: number } = {}, now = new Date()): Promise<SyncResult[]> {
  let targets: Account[];
  if (options.accountId !== undefined) {
    const one = await deps.registry.account(options.accountId);
    if (!one) throw new MissingField(`no account ${options.accountId}`);
    targets = [one];
  } else {
    targets = (await deps.registry.accounts()).filter((a) => deps.brands.has(a.brand));
  }
  const results: SyncResult[] = [];
  for (const account of targets) results.push(await syncAccount(deps, account, now));
  return results;
}
