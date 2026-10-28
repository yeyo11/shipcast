import { proposalEdit } from '@shipcast/engine';
import { createServerFn } from '@tanstack/react-start';
import { appContext } from './context.server';
import { apiErrorOf } from './errors';
import { id, InvalidInput, object, text } from './input';
import { profileView, reviewInput } from './profile-api';
import { applyEdit, startReview } from './profiles.server';

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
    const job = await (await appContext()).registry.job(data);
    return job ? { state: job.state, log: job.log } : null;
  });

const FIELDS = ['displayName', 'bio', 'links'] as const;

/**
 * Applies one proposal on the network, after the page asked the owner to confirm it. The value is
 * the proposal's text as the owner may have changed it; the engine checks the capability and the
 * limits again before anything is sent.
 */
export const applyProfileProposal = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const o = object(input, 'input');
    const field = text(o.field, 'field', 20);
    if (!(FIELDS as readonly string[]).includes(field)) throw new InvalidInput(`field is one of ${FIELDS.join(', ')}`);
    return { id: id(o.id), field: field as (typeof FIELDS)[number], value: text(o.value, 'value', 5000) };
  })
  .handler(async ({ data }) => {
    try {
      const profile = await applyEdit(data.id, proposalEdit({ field: data.field, proposed: data.value }));
      return { ok: true as const, profile: profile ?? null };
    } catch (error) {
      // A refusal or the network's answer is the page's to show; a bug is the log's
      const answer = apiErrorOf(error);
      if (!answer.internal) return { ok: false as const, problem: answer.message };
      throw error;
    }
  });
