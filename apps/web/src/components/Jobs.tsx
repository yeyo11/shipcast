import { useEffect, useState } from 'react';
import { getJobsPage } from '../server/automation.functions';
import type { JobsPageView, JobStateFilter } from '../server/jobs.server';
import { Pill, when } from './ui';
import { ScrollArea } from './ui/ScrollArea';

export interface JobView {
  id: string;
  title: string;
  state: 'running' | 'done' | 'failed';
  log: string[];
  link: string | null;
  startedAt: string;
}

function JobRows({ jobs }: { jobs: JobView[] }) {
  return (
    <ul className="list">
      {jobs.map((job) => (
        <li key={job.id}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <strong>{job.title}</strong> <span className="muted">since {when(job.startedAt)}</span>
            {job.log.length > 0 && <div className="muted" style={{ fontSize: 14, overflowWrap: 'anywhere' }}>{job.log.at(-1)}</div>}
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
  );
}

/** A launch's jobs (a handful): a bounded list that scrolls inside the page */
export function Jobs({ jobs }: { jobs: JobView[] }) {
  if (jobs.length === 0) return null;
  return (
    <section aria-label="Work in progress" style={{ marginBottom: 36 }}>
      <ScrollArea maxHeight="420px" label="Jobs, scrollable">
        <JobRows jobs={jobs} />
      </ScrollArea>
    </section>
  );
}

const FILTERS: Array<{ id: JobStateFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'running', label: 'Running' },
  { id: 'failed', label: 'Failed' },
  { id: 'done', label: 'Done' },
];

/**
 * The queue's work of the last day: drafting, publishing, GitHub's deliveries; kept across restarts.
 * Ten to a page, cut on the server, filtered by state, in a box of bounded height. The first page of
 * every state comes with the route; any other page or filter is fetched, and fetched again whenever the
 * route's data refreshes (the page follows a running round), so it never shows a stale list.
 */
export function JobsPanel({ initial }: { initial: JobsPageView }) {
  const [state, setState] = useState<JobStateFilter>('all');
  const [page, setPage] = useState(1);
  const [fetched, setFetched] = useState<JobsPageView | null>(null);
  const [failed, setFailed] = useState(false);
  const isFirst = state === 'all' && page === 1;

  useEffect(() => {
    if (isFirst) {
      setFetched(null);
      return;
    }
    let live = true;
    getJobsPage({ data: { page, state } })
      .then((view) => {
        if (!live) return;
        setFetched(view);
        setFailed(false);
        // The list shrank under the pager: follow it to the page that still exists
        if (view.page !== page) setPage(view.page);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [state, page, isFirst, initial]);

  const view = isFirst ? initial : (fetched ?? initial);
  if (initial.counts.all === 0) return null;

  return (
    <section aria-label="Work in progress" className="jobs-panel">
      <div className="jobs-bar">
        <div className="seg" role="radiogroup" aria-label="Filter by state">
          {FILTERS.map((f) => (
            <label key={f.id}>
              <input
                type="radio"
                name="jobs-state"
                checked={state === f.id}
                onChange={() => {
                  setState(f.id);
                  setPage(1);
                }}
              />
              <span>
                {f.label} <small>{view.counts[f.id]}</small>
              </span>
            </label>
          ))}
        </div>
      </div>
      {failed && <p className="muted">That page could not be loaded; showing the last one.</p>}
      {view.jobs.length === 0 ? (
        <p className="muted">No {state === 'all' ? '' : `${state} `}jobs in the last day.</p>
      ) : (
        <ScrollArea maxHeight="480px" label="Jobs, scrollable">
          <JobRows jobs={view.jobs} />
        </ScrollArea>
      )}
      {view.pageCount > 1 && (
        <nav className="jobs-pager" aria-label="Jobs pages">
          <button className="btn btn-small" type="button" disabled={view.page <= 1} onClick={() => setPage(view.page - 1)}>
            Previous
          </button>
          <span className="muted" aria-live="polite">
            Page {view.page} of {view.pageCount} · {view.total} {view.total === 1 ? 'job' : 'jobs'}
          </span>
          <button className="btn btn-small" type="button" disabled={view.page >= view.pageCount} onClick={() => setPage(view.page + 1)}>
            Next
          </button>
        </nav>
      )}
    </section>
  );
}
