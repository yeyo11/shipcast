import { useEffect, useState } from 'react';
import { getJobsPage } from '../server/automation.functions';
import type { JobsPageView, JobStateFilter } from '../server/jobs.server';
import { Pill, when } from './ui';
import { ScrollArea } from './ui/ScrollArea';

export interface JobView {
  id: string;
  title: string;
  state: 'running' | 'done' | 'failed';
  /** Queued for a time still to come (a scheduled piece), not started: not work in progress */
  queued?: boolean;
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

/** A job's state as word and shape (the kit's pills) */
function JobPill({ state }: { state: JobView['state'] }) {
  if (state === 'running') return <span className="k-pill k-p-run">Running</span>;
  if (state === 'done') return <span className="k-pill k-p-pub">Done</span>;
  return <span className="k-pill k-p-fail">Failed</span>;
}

/**
 * The queue's work of the last day: drafting, publishing, GitHub's deliveries; kept across restarts.
 * Ten to a page, cut on the server, filtered by state (Settings › Automation, in a sheet). The first
 * page of every state comes with the route; any other page or filter is fetched, and fetched again
 * whenever the route's data refreshes (the page follows a running round), so it never shows a stale list.
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

  return (
    <section aria-label="Work in progress" className="k-stack k-g12">
      <div className="k-seg" role="radiogroup" aria-label="Filter by state">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            role="radio"
            aria-checked={state === f.id}
            className={state === f.id ? 'k-on' : undefined}
            onClick={() => {
              setState(f.id);
              setPage(1);
            }}
          >
            {f.label} {view.counts[f.id]}
          </button>
        ))}
      </div>
      {failed && <p className="k-sm k-muted st-m0">That page could not be loaded; showing the last one.</p>}
      {view.jobs.length === 0 ? (
        <p className="k-sm k-muted st-m0">No {state === 'all' ? '' : `${state} `}jobs in the last day.</p>
      ) : (
        <div>
          {view.jobs.map((job) => (
            <div key={job.id} className="k-row">
              <span className="k-grow">
                <strong className="k-sm">{job.title}</strong>
                <br />
                <span className="k-xs k-muted st-anywhere">
                  since {when(job.startedAt)}
                  {job.log.length > 0 ? ` · ${job.log.at(-1)}` : ''}
                </span>
              </span>
              {job.link && (
                <a className="k-btn k-sm" href={job.link}>
                  Open
                </a>
              )}
              <JobPill state={job.state} />
            </div>
          ))}
        </div>
      )}
      {view.pageCount > 1 && (
        <nav className="k-hrow k-between k-g8" aria-label="Jobs pages">
          <button className="k-btn k-sm" type="button" disabled={view.page <= 1} onClick={() => setPage(view.page - 1)}>
            Previous
          </button>
          <span className="k-xs k-muted" aria-live="polite">
            {view.page} of {view.pageCount} · {view.total} {view.total === 1 ? 'job' : 'jobs'}
          </span>
          <button className="k-btn k-sm" type="button" disabled={view.page >= view.pageCount} onClick={() => setPage(view.page + 1)}>
            Next
          </button>
        </nav>
      )}
    </section>
  );
}
