import type { CommentDeps } from '@shipcast/engine';
import { BY_HAND, checkComments as queueCheck, commentConnectors, redraftComment as queueRedraft } from '@shipcast/runtime';
import { appContext } from './context.server';

type Started = { ok: true; job: string } | { ok: false; problem: string };

/** What sending a reply needs in the app: each post's connectors, built with the account it went out with */
export async function commentDeps(): Promise<CommentDeps> {
  const ctx = await appContext();
  return { registry: ctx.registry, connectors: commentConnectors({ env: process.env, brand: await ctx.brand(), registry: ctx.registry, secrets: ctx.secrets }) };
}

/** "Check comments now": a run by hand, whatever the automation mode */
export async function checkComments(): Promise<Started> {
  const job = await queueCheck((await appContext()).queue, BY_HAND);
  return job ? { ok: true, job } : { ok: false, problem: 'the run could not be queued' };
}

export async function redraftComment(commentId: number): Promise<Started> {
  const { queue, registry } = await appContext();
  if (!(await registry.comment(commentId))) return { ok: false, problem: 'no such comment' };
  const job = await queueRedraft(queue, commentId, BY_HAND);
  return job ? { ok: true, job } : { ok: false, problem: 'the draft could not be queued' };
}
