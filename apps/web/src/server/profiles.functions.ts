import { createServerFn } from '@tanstack/react-start';
import { appContext } from './context.server';
import { apiErrorOf } from './errors';
import { id, object, text } from './input';
import { profileView, proposalInput, reviewInput } from './profile-api';
import { applyBrandPicture, applyProposal, startReview } from './profiles.server';

/** An account's profile capability and latest review, for its panel on the network's page */
export const getProfileReview = createServerFn({ method: 'GET' })
  .validator((input: unknown) => id(input))
  .handler(async ({ data }) => (await profileView((await appContext()).registry, data)) ?? null);

/** Starts a review as a job; the page follows the job and reads the review once it is done */
export const reviewProfileNow = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const o = object(input, 'input');
    return { id: id(o.id), request: reviewInput(o.request ?? {}) };
  })
  .handler(async ({ data }) => startReview(data.id, data.request));

/** Where a review's job stands: the page polls it while the AI works */
export const profileReviewJob = createServerFn({ method: 'GET' })
  .validator((input: unknown) => text(input, 'job', 200))
  .handler(async ({ data }) => {
    const job = await (await appContext()).registry.jobs.job(data);
    return job ? { state: job.state, log: job.log } : null;
  });

/** Applies one proposal on the network (applyProposal), after the page asked the owner to confirm it */
export const applyProfileProposal = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const o = object(input, 'input');
    return { id: id(o.id), proposal: proposalInput(o) };
  })
  .handler(async ({ data }) => {
    try {
      const profile = await applyProposal(data.id, data.proposal);
      return { ok: true as const, profile: profile ?? null };
    } catch (error) {
      // A refusal or the network's answer is the page's to show; a bug is the log's
      const answer = apiErrorOf(error);
      if (!answer.internal) return { ok: false as const, problem: answer.message };
      throw error;
    }
  });

/** Sets brand.yml's avatar as the account's picture, after the page asked the owner to confirm it */
export const applyBrandPictureNow = createServerFn({ method: 'POST' })
  .validator((input: unknown) => id(input))
  .handler(async ({ data }) => {
    try {
      return { ok: true as const, profile: (await applyBrandPicture(data)) ?? null };
    } catch (error) {
      const answer = apiErrorOf(error);
      if (!answer.internal) return { ok: false as const, problem: answer.message };
      throw error;
    }
  });
