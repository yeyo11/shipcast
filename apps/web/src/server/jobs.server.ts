import { UNFINISHED_JOB_STATES, type JobCursor, type JobRecord, type JobState, type Registry } from '@shipcast/engine';
import type { JobView } from '../components/Jobs';

/**
 * The queue's work as the app shows it, from the registry's `jobs` rows, so a job started before a
 * restart is still listed after it. The registry's `listed` filter leaves out what the list never
 * shows (rounds that ended well, jobs that found automation off), so pages and counts are the
 * database's and the day is never cut at a fixed number of rows.
 */
export function jobView(job: JobRecord): JobView {
  return {
    id: job.id,
    title: job.title,
    // Waiting for its next attempt is still running, to the owner; the last line says what it waits for
    state: job.state === 'completed' ? 'done' : job.state === 'failed' ? 'failed' : 'running',
    queued: job.state === 'created' && !job.startedAt,
    log: job.log.slice(-8),
    link: job.link,
    startedAt: job.startedAt ?? job.createdAt,
  };
}

const lastDay = () => new Date(Date.now() - 86_400_000).toISOString();

/** A launch's jobs, whenever they ran: a handful */
export async function jobsView(registry: Registry, filter: { launchId: number }): Promise<JobView[]> {
  return (await registry.jobs.jobs({ launchId: filter.launchId, listed: true, limit: 20 })).map(jobView);
}

export const JOBS_FEED_LIMIT = 30;

/** One page of the last day's jobs for the API, the newest first; `next` is where the following page starts */
export async function jobsFeed(registry: Registry, page: { limit?: number; before?: JobCursor } = {}): Promise<{ jobs: JobView[]; next: JobCursor | null }> {
  const limit = page.limit ?? JOBS_FEED_LIMIT;
  // One more than asked tells whether a next page exists, without a count
  const rows = await registry.jobs.jobs({ since: lastDay(), listed: true, limit: limit + 1, ...(page.before && { before: page.before }) });
  const shown = rows.slice(0, limit);
  const last = shown.at(-1);
  return { jobs: shown.map(jobView), next: rows.length > limit && last ? { createdAt: last.createdAt, id: last.id } : null };
}

export const JOB_PAGE_SIZE = 10;
export type JobStateFilter = 'all' | JobView['state'];

export interface JobsPageView {
  jobs: JobView[];
  /** Jobs in the chosen state */
  total: number;
  page: number;
  pageCount: number;
  /** How many there are in each state, so the filter can say what it would show */
  counts: Record<JobStateFilter, number>;
}

const STATES: Record<Exclude<JobStateFilter, 'all'>, readonly JobState[]> = { running: UNFINISHED_JOB_STATES, failed: ['failed'], done: ['completed'] };

/**
 * One numbered page of the last day's jobs, in one state or all. Numbered pages with a total want
 * an offset rather than a cursor (a cursor cannot jump to "page 3 of 5"); the list covers one day
 * and ended jobs are pruned, so the offset stays small, and the counts come from one grouped query.
 */
export async function jobsPage(registry: Registry, { page, state }: { page: number; state: JobStateFilter }): Promise<JobsPageView> {
  const since = lastDay();
  const byState = await registry.jobs.jobCounts({ since, listed: true });
  const running = byState.created + byState.active + byState.retry;
  const counts: Record<JobStateFilter, number> = { all: running + byState.failed + byState.completed, running, failed: byState.failed, done: byState.completed };
  const total = counts[state];
  const pageCount = Math.max(1, Math.ceil(total / JOB_PAGE_SIZE));
  // A page past the end (the list shrank since it was shown) falls back to the last one
  const at = Math.min(Math.max(1, page), pageCount);
  const jobs = await registry.jobs.jobs({
    since,
    listed: true,
    ...(state !== 'all' && { states: STATES[state] }),
    limit: JOB_PAGE_SIZE,
    offset: (at - 1) * JOB_PAGE_SIZE,
  });
  return { jobs: jobs.map(jobView), total, page: at, pageCount, counts };
}
