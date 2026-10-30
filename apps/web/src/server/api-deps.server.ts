import { processState } from '@shipcast/runtime/redis';
import { FailureLimiter, sharedLimiter, type ApiDeps, type SignInLimiter } from './api';
import { appContext } from './context.server';
import { deletionService } from './deletion.server';
import { jobsFeed } from './jobs.server';
import { checkComments, commentDeps, redraftComment } from './comments.server';
import { editingDeps } from './posts.server';
import { profileApi } from './profiles.server';
import { approve, armSchedule, startArticle, startLaunch, startPublishing, startSources, uploadSource } from './work.server';

/**
 * Shared by /api/v1 and /mcp, so wrong tokens count once whichever door they knock on: per process as
 * before, or with `redis-state` on, across every replica
 */
let limiter: SignInLimiter | undefined;
const limiterOf = (): SignInLimiter => {
  const { shared } = processState();
  limiter ??= shared.backend === 'redis' ? sharedLimiter(shared.signInFailures) : new FailureLimiter();
  return limiter;
};

/** What the REST API runs on, read per request so a change in Settings (the launches repo) applies at once */
export async function apiDeps(): Promise<ApiDeps> {
  const ctx = await appContext();
  return {
    registry: ctx.registry,
    secrets: ctx.secrets,
    github: ctx.github,
    launchesRepo: ctx.deps.launchesRepo,
    launchRead: ctx.launchRead,
    publicUrl: ctx.app.publicUrl,
    limiter: limiterOf(),
    jobs: (page) => jobsFeed(ctx.registry, page),
    startLaunch,
    approve,
    startArticle,
    startPublishing,
    editing: editingDeps,
    armSchedule,
    comments: commentDeps,
    checkComments,
    redraftComment,
    profiles: profileApi,
    ...(ctx.flags.on('launch-sources') && { sources: { start: startSources, upload: uploadSource } }),
    deletion: deletionService(ctx),
  };
}
