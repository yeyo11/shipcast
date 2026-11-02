import { isAppLaunch, type AppReviewService, type Launch } from '@shipcast/engine';
import { launchService } from './app-services.ts';
import type { AppContext } from './context.server.ts';
import type { DraftsApi, Refusal } from './drafts-api.ts';
import { fakeNetworks, PREVIEW_REFUSAL } from './preview.server.ts';

/*
 * A launch's drafts, as the drafts routes (drafts-api.ts) and the launch page's server functions
 * (launches.functions.ts) both need them: edited, previewed on the real site. One implementation,
 * two doors. A refusal is answered as data; anything else is thrown, for the page to show its words
 * and the API to answer it by its own status.
 */

const NO_LAUNCH: Refusal = { ok: false, problem: 'no such launch' };

/** A launch Shipcast holds, for its preview on the real site; a refusal when it is not one */
async function heldLaunch(ctx: AppContext, launchId: number): Promise<{ ok: true; launch: Launch; service: AppReviewService } | Refusal> {
  const launch = await launchService(ctx).get(launchId);
  if (!launch) return NO_LAUNCH;
  if (!isAppLaunch(launch)) return { ok: false, problem: 'this launch was decided in its pull request, which had its own preview' };
  return { ok: true, launch, service: ctx.appReview };
}

/** What the drafts routes run in the app's process, built per request by api-deps.server.ts */
export function draftsApi(ctx: AppContext): DraftsApi {
  const launches = launchService(ctx);
  return {
    async edit(launchId, path, content, by) {
      const launch = await launches.get(launchId);
      if (!launch) return NO_LAUNCH;
      // The review's refusals (a piece out already, a text too long for its network…) are thrown with their own status
      await launches.editDraft(launch.id, path, content, by);
      return { ok: true };
    },

    async requestPreview(launchId) {
      // It writes a branch and a pull request on the real launches repo
      if (fakeNetworks()) return { ok: false, problem: PREVIEW_REFUSAL };
      const held = await heldLaunch(ctx, launchId);
      if (!held.ok) return held;
      return { ok: true, preview: await held.service.requestPreview(held.launch) };
    },

    async findPreview(launchId) {
      const held = await heldLaunch(ctx, launchId);
      if (!held.ok) return held;
      const preview = await held.service.findPreview(held.launch);
      return preview ? { ok: true, preview } : { ok: false, problem: 'no preview was asked for' };
    },
  };
}
