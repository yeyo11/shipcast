import { createServerFn } from '@tanstack/react-start';
import type { PostChanges } from '@shipcast/engine';
import { appContext } from './context.server';
import { cancel, deleteAll, deleteOne, editMany, editOne, move, recommend, schedule, type PostActionDeps } from './post-actions';
import { editingDeps } from './posts.server';
import { armSchedule } from './work.server';

/*
 * The launch page's actions on its published pieces and their times. Thin over post-actions.ts,
 * which checks every request as the REST API does and answers refusals as data. The validators
 * below only type what the page sends; the checking happens in the action, so a bad request comes
 * back as a problem the page explains instead of a thrown error.
 */

async function deps(): Promise<PostActionDeps> {
  const ctx = await appContext();
  return { registry: ctx.registry, editing: editingDeps, armSchedule, github: ctx.github, launchesRepo: ctx.deps.launchesRepo, launchRead: ctx.launchRead };
}

export const editPiece = createServerFn({ method: 'POST' })
  .validator((input: { postId: number; changes: PostChanges }) => input)
  .handler(async ({ data }) => editOne(await deps(), data));

export const deletePiece = createServerFn({ method: 'POST' })
  .validator((input: { postId: number }) => input)
  .handler(async ({ data }) => deleteOne(await deps(), data));

export const editPieces = createServerFn({ method: 'POST' })
  .validator((input: { launchId: number; postIds: number[]; changes: PostChanges }) => input)
  .handler(async ({ data }) => editMany(await deps(), data));

export const deleteAllPieces = createServerFn({ method: 'POST' })
  .validator((input: { launchId: number; confirm: string }) => input)
  .handler(async ({ data }) => deleteAll(await deps(), data));

export const schedulePiece = createServerFn({ method: 'POST' })
  .validator((input: { launchId: number; channel: string; at: string }) => input)
  .handler(async ({ data }) => schedule(await deps(), data));

export const moveSchedule = createServerFn({ method: 'POST' })
  .validator((input: { postId: number; at: string }) => input)
  .handler(async ({ data }) => move(await deps(), data));

export const cancelSchedule = createServerFn({ method: 'POST' })
  .validator((input: { postId: number }) => input)
  .handler(async ({ data }) => cancel(await deps(), data));

export const recommendedTimes = createServerFn({ method: 'GET' })
  .validator((input: { channel: string }) => input)
  .handler(async ({ data }) => recommend(await deps(), data));
