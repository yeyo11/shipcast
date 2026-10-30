import type { EditDeps } from '@shipcast/engine';
import { postEditors } from '@shipcast/runtime';
import { appContext } from './context.server';
import { fakeBlogRepo } from './preview.server';

/**
 * What editing and deleting published pieces needs in the app: each piece's connectors built with
 * the account it went out with, the launches repo for the blog's articles, and the brand's site
 * whose links an edit tags.
 */
export async function editingDeps(): Promise<EditDeps> {
  const ctx = await appContext();
  // A preview with fake networks edits and deletes nothing real, whatever the copy of the data says
  if (ctx.preview) return { registry: ctx.registry, editors: ctx.preview.editors, blog: { github: fakeBlogRepo, launchesRepo: ctx.deps.launchesRepo } };
  const brand = await ctx.brand();
  return {
    registry: ctx.registry,
    editors: postEditors({ env: process.env, brand, registry: ctx.registry, secrets: ctx.secrets, github: ctx.github }),
    // An edit's links are tagged as the piece's were when it went out (docs/tracking.md)
    site: brand.site,
    blog: { github: ctx.github, launchesRepo: ctx.deps.launchesRepo },
    launchStore: ctx.launchStore,
  };
}
