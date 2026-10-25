import { Pill, when } from './ui';

export interface JobView {
  id: string;
  title: string;
  state: 'running' | 'done' | 'failed';
  log: string[];
  link: string | null;
  startedAt: string;
}

/** The queue's work of the last day: drafting, publishing, GitHub's deliveries; kept across restarts */
export function Jobs({ jobs }: { jobs: JobView[] }) {
  if (jobs.length === 0) return null;
  return (
    <section aria-label="Work in progress">
      <ul className="list" style={{ marginBottom: 36 }}>
        {jobs.map((job) => (
          <li key={job.id}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <strong>{job.title}</strong> <span className="muted">since {when(job.startedAt)}</span>
              {job.log.length > 0 && <div className="muted" style={{ fontSize: 14 }}>{job.log.at(-1)}</div>}
            </div>
            <div className="row">
              {job.link && (
                <a className="btn btn-small" href={job.link}>
                  Open
                </a>
              )}
              <Pill tone={job.state === 'running' ? 'draft' : job.state === 'done' ? 'published' : 'failed'}>
                {job.state === 'running' ? 'Running' : job.state === 'done' ? 'Done' : 'Failed'}
              </Pill>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
