import { FailureLimiter, type ApiDeps } from './api';
import { appContext } from './context.server';
import { jobsView } from './jobs.server';
import { checkComments, commentDeps, redraftComment } from './comments.server';
import { editingDeps } from './posts.server';
import { approve, armSchedule, startArticle, startLaunch, startPublishing } from './work.server';

/** One per process and shared by /api/v1 and /mcp, so wrong tokens count once whichever door they knock on */
const limiter = new FailureLimiter();

/** What the REST API runs on, read per request so a change in Settings (the launches repo) applies at once */
export async function apiDeps(): Promise<ApiDeps> {
  const ctx = await appContext();
  return {
    registry: ctx.registry,
    secrets: ctx.secrets,
    github: ctx.github,
    launchesRepo: ctx.deps.launchesRepo,
    publicUrl: ctx.app.publicUrl,
    limiter,
    jobs: () => jobsView(ctx.registry),
    startLaunch,
    approve,
    startArticle,
    startPublishing,
    editing: editingDeps,
    armSchedule,
    comments: commentDeps,
    checkComments,
    redraftComment,
  };
}
