import { reviewProfile, setupFor, type Account, type PipelineDeps, type ProfileConnector, type ProfileDeps, type Repositories } from '@shipcast/engine';
import type { Brand } from '@shipcast/schema';
import { buildConnector, MissingField } from './catalog.ts';
import type { WorkQueue } from './queue.ts';
import { getJson, type SecretStore } from './secrets.ts';
import { accountSecretKey } from './services.ts';

/*
 * Account analysis in this process: an account's connector built with its own credential from the
 * keychain, the `profile` AI task, and the job that runs a review. Applying a proposal is never a
 * job: the owner's click (after a confirmation) makes the edit. See docs/decisions/account-analysis.md
 */

export interface ProfileWorkDeps {
  registry: Pick<Repositories, 'launches' | 'accounts' | 'cursors' | 'queries'>;
  secrets: SecretStore;
  pipeline: PipelineDeps;
  brand: Brand;
  fetch?: typeof fetch;
}

/** An account's connector, with that account's own credential; undefined when its secrets are gone */
export function profileConnector(d: Pick<ProfileWorkDeps, 'secrets' | 'brand' | 'fetch'>): (account: Account) => Promise<ProfileConnector | undefined> {
  return async (account) => {
    const secrets = await getJson(d.secrets, accountSecretKey(account.id));
    if (!secrets) return undefined;
    try {
      return buildConnector(account.network, { settings: account.settings, secrets }, d.brand, d.fetch);
    } catch (error) {
      if (error instanceof MissingField) return undefined;
      throw error;
    }
  };
}

export function profileDeps(d: ProfileWorkDeps): ProfileDeps {
  return {
    registry: d.registry,
    brand: d.brand,
    setup: () => setupFor(d.pipeline, 'profile'),
    // A review reads no repo: the provider works in its workspace root, as for an article's reply
    cwd: d.pipeline.aiWorkdir ?? '/workspace',
    connector: profileConnector(d),
  };
}

/** What the owner gave a review: the profile pasted where the network cannot read it, and its language */
export interface ProfileReviewRequest {
  accountId: number;
  pasted?: { displayName?: string; bio?: string; links?: string };
  language?: string;
}

/** The key of one account's review: a second click while one is queued is the same job */
const reviewKey = (accountId: number) => `profile:${accountId}`;

/**
 * Queues a review of one account's profile. The review already queued for that account, if any, is
 * the one that answers, so clicking twice never asks the AI twice.
 */
export async function startProfileReview(queue: WorkQueue, account: Pick<Account, 'id' | 'label'>, request: Omit<ProfileReviewRequest, 'accountId'> = {}): Promise<string | undefined> {
  const id = await queue.send('profile-review', { accountId: account.id, ...request }, { title: `Reviewing the profile of ${account.label}`, singletonKey: reviewKey(account.id) });
  if (id) return id;
  const [waiting] = await queue.queued('profile-review', reviewKey(account.id));
  return waiting;
}

/** The job: one review, its proposals in the job's log, failing with the reason when it could not */
export async function runProfileReview(d: ProfileWorkDeps, request: ProfileReviewRequest, log: (line: string) => void): Promise<void> {
  const review = await reviewProfile(profileDeps(d), request.accountId, { ...(request.pasted && { pasted: request.pasted }), ...(request.language && { language: request.language }) });
  log(review.summary || 'Reviewed');
  if (review.proposals.length === 0) log('No change proposed: the profile already works');
  for (const p of review.proposals) log(`${p.field}: ${p.proposed}${p.problem ? ` (${p.problem})` : ''}`);
}
