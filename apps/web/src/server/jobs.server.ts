import type { JobRecord, Registry } from '@shipcast/engine';
import type { JobView } from '../components/Jobs';

/**
 * The queue's work as the app shows it, from the registry's `jobs` rows, so a job started before a
 * restart is still listed after it. Rounds run all day and the Automation page has the last one, so
 * a round is listed only while running or when it failed; nor is a job that found automation off.
 */
const shown = (job: JobRecord) =>
  (job.queue !== 'round' || job.state === 'active' || job.state === 'failed') && !(job.state === 'completed' && job.log[0]?.startsWith('Automation is off'));

export function jobView(job: JobRecord): JobView {
  return {
    id: job.id,
    title: job.title,
    // Waiting for its next attempt is still running, to the owner; the last line says what it waits for
    state: job.state === 'completed' ? 'done' : job.state === 'failed' ? 'failed' : 'running',
    log: job.log.slice(-8),
    link: job.link,
    startedAt: job.startedAt ?? job.createdAt,
  };
}

/** The last day's jobs, the newest first; or a launch's, whenever they ran */
export async function jobsView(registry: Registry, filter: { launchId?: number } = {}): Promise<JobView[]> {
  const jobs =
    filter.launchId === undefined
      ? await registry.jobs({ since: new Date(Date.now() - 86_400_000).toISOString(), limit: 200 })
      : await registry.jobs({ launchId: filter.launchId, limit: 20 });
  return jobs.filter(shown).slice(0, 30).map(jobView);
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

/**
 * One page of the last day's jobs, in one state or all. The registry has no offset, and `shown`
 * drops rows after the query, so the day's jobs (at most 200) are read once and cut here: the page
 * receives ten of them, not the lot.
 */
export async function jobsPage(registry: Registry, { page, state }: { page: number; state: JobStateFilter }): Promise<JobsPageView> {
  const all = (await registry.jobs({ since: new Date(Date.now() - 86_400_000).toISOString(), limit: 200 })).filter(shown).map(jobView);
  const counts: Record<JobStateFilter, number> = { all: all.length, running: 0, failed: 0, done: 0 };
  for (const job of all) counts[job.state] += 1;
  const matching = state === 'all' ? all : all.filter((j) => j.state === state);
  const pageCount = Math.max(1, Math.ceil(matching.length / JOB_PAGE_SIZE));
  // A page past the end (the list shrank since it was shown) falls back to the last one
  const at = Math.min(Math.max(1, page), pageCount);
  return { jobs: matching.slice((at - 1) * JOB_PAGE_SIZE, at * JOB_PAGE_SIZE), total: matching.length, page: at, pageCount, counts };
}
