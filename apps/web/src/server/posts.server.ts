import type { EditDeps } from '@shipcast/engine';
import { postEditors } from '@shipcast/runtime';
import { appContext } from './context.server';

/**
 * What editing and deleting published pieces needs in the app: each piece's connectors built with
 * the account it went out with, and the launches repo for the blog's articles.
 */
export async function editingDeps(): Promise<EditDeps> {
  const ctx = await appContext();
  return {
    registry: ctx.registry,
    editors: postEditors({ env: process.env, brand: await ctx.brand(), registry: ctx.registry, secrets: ctx.secrets }),
    blog: { github: ctx.github, launchesRepo: ctx.deps.launchesRepo },
  };
}
