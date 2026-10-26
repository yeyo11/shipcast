import type { EditDeps } from '@shipcast/engine';
import { postEditors } from '@shipcast/runtime';
import { appContext } from './context.server';
import { fakeBlogRepo, fakeEditors, fakeNetworks } from './preview.server';

/**
 * What editing and deleting published pieces needs in the app: each piece's connectors built with
 * the account it went out with, and the launches repo for the blog's articles.
 */
export async function editingDeps(): Promise<EditDeps> {
  const ctx = await appContext();
  // A preview with fake networks edits and deletes nothing real, whatever the copy of the data says
  if (fakeNetworks()) return { registry: ctx.registry, editors: fakeEditors, blog: { github: fakeBlogRepo, launchesRepo: ctx.deps.launchesRepo } };
  return {
    registry: ctx.registry,
    editors: postEditors({ env: process.env, brand: await ctx.brand(), registry: ctx.registry, secrets: ctx.secrets, github: ctx.github }),
    blog: { github: ctx.github, launchesRepo: ctx.deps.launchesRepo },
  };
}
