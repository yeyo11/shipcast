import type { Profile, ProfileEdit } from '@shipcast/connectors';
import { editProfile, type ProfileDeps } from '@shipcast/engine';
import { profileDeps, startProfileReview, type ProfileReviewRequest } from '@shipcast/runtime';
import type { ProfileApi } from './profile-api';
import { appContext } from './context.server';
import { fakeNetworks } from './preview.server';

/*
 * Account analysis in the app: a review is a job of the queue (an AI run takes a while), an edit is
 * made at once, after the page asked the owner to confirm it. A preview with fake networks never
 * edits a real profile: the edit is logged and answered as made.
 */

async function deps(): Promise<ProfileDeps> {
  const ctx = await appContext();
  return profileDeps({ registry: ctx.registry, secrets: ctx.secrets, pipeline: ctx.deps, brand: await ctx.brand() });
}

export async function startReview(accountId: number, request: Omit<ProfileReviewRequest, 'accountId'>): Promise<{ ok: true; job: string } | { ok: false; problem: string }> {
  const { queue, registry } = await appContext();
  const account = await registry.account(accountId);
  if (!account) return { ok: false, problem: 'no such account' };
  const job = await startProfileReview(queue, account, request);
  return job ? { ok: true, job } : { ok: false, problem: 'the review could not be queued' };
}

export async function applyEdit(accountId: number, edit: ProfileEdit): Promise<Profile | undefined> {
  const d = await deps();
  if (fakeNetworks()) {
    // The checks still run, so a preview refuses what production would; only the network is faked
    return editProfile(
      {
        ...d,
        connector: async () => ({
          editProfile: async (e) => console.log(`[preview, fake network] would edit the profile of account ${accountId}: ${JSON.stringify(e)}`),
        }),
      },
      accountId,
      edit,
    );
  }
  return editProfile(d, accountId, edit);
}

/** What the REST API runs for profiles in this process */
export const profileApi: ProfileApi = { review: startReview, edit: applyEdit };
