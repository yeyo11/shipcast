import { inTransaction, LaunchDeletionService } from '@shipcast/engine';
import { postService } from './app-services';
import type { AppContext } from './context.server';
import { editingDeps } from './posts.server';

/**
 * With `launch-delete`: deleting a launch (docs/launch-delete.md), one construction for the launch
 * page and the REST API. On a preview with fake networks nothing is closed on GitHub and no media
 * bytes are dropped: only the copy of the data changes, and the posts go through the fake networks.
 */
export function deletionService(ctx: AppContext): LaunchDeletionService | undefined {
  if (!ctx.flags.on('launch-delete')) return undefined;
  const real = !ctx.preview;
  const appReview = ctx.appReview;
  return new LaunchDeletionService({
    registry: ctx.registry,
    inTransaction: (work) => inTransaction(ctx.registry, work),
    posts: postService({ registry: ctx.registry, editing: editingDeps }),
    github: real ? ctx.github : { pullRequestState: (repo, number) => ctx.github.pullRequestState(repo, number), closePreview: async () => undefined },
    get launchesRepo() {
      return ctx.deps.launchesRepo;
    },
    ...(appReview && { appReview: real ? appReview : { closePreview: async () => undefined } }),
    ...(real && { media: ctx.media }),
  });
}
