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
