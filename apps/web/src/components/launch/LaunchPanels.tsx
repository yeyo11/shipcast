import { Link } from '@tanstack/react-router';
import { useEffect, useState, type ReactNode } from 'react';
import type { JobView } from '../Jobs';
import { Icon } from '../kit/Icon';
import { PublishFailed, Typewriter } from '../illustrations';
import { signed, type AccountRow } from '../../server/pieces';
import { number } from '../ui';
import { ChannelGlyph, channelTitle } from './ChannelGlyph';
import { ago, dayOnly, dayTime, elapsed } from './dates';

/*
 * The rest of a launch's page (boards LaunchSearch, LaunchDetails, LaunchDrafting, LaunchFailed):
 * whether search engines have the article, what the launch is with every number it read and its
 * jobs, the launch while it is drafted, and a launch that failed before anything went out.
 */

/** The clock the page's "ago" and running times read, ticking while it is open */
export function useNow(every = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), every);
    return () => clearInterval(timer);
  }, [every]);
  return now;
}

/* ---------- Search ---------- */

export interface IndexRow {
  engine: string;
  lang: string;
  url: string;
  indexed: boolean | null;
  coverage: string | null;
  checkedAt: string | null;
}

const engineName = (engine: string) => (engine === 'bing' ? 'Bing' : engine === 'google' ? 'Google' : engine.charAt(0).toUpperCase() + engine.slice(1));
const LANGUAGES: Record<string, string> = { en: 'English', es: 'Spanish' };

export function SearchPanel({ index, timezone }: { index: IndexRow[]; timezone: string }) {
  const now = useNow();
  if (index.length === 0) return <p className="k-px k-sm k-muted pub-intro">No article of this launch is on the blog, so there is nothing for a search engine to index.</p>;
  const engines = [...new Set(index.map((i) => engineName(i.engine)))];
  return (
    <>
      <p className="k-px k-sm k-muted pub-intro">
        Whether {engines.length > 1 ? `${engines.slice(0, -1).join(', ')} and ${engines.at(-1)}` : engines[0]} {index.length > 1 ? 'have' : 'has'} the article yet. Shipcast asks at every metrics reading.
      </p>
      <div className="k-px k-stack pub-search">
        {index.map((i) => {
          const engine = engineName(i.engine);
          const yes = i.engine === 'bing' ? 'Crawled' : 'Indexed';
          const checked = i.checkedAt ? `checked ${ago(i.checkedAt, now, timezone)}` : '';
          return (
            <div key={`${i.engine} ${i.url}`} className="k-row">
              <span className="k-ic">
                <Icon name={i.engine === 'bing' ? 'search' : 'globe'} />
              </span>
              <div className="k-grow k-stack">
                <strong>
                  {engine} ·{' '}
                  <a href={i.url} target="_blank" rel="noreferrer">
                    {LANGUAGES[i.lang] ?? i.lang.toUpperCase()}
                    <span className="visually-hidden"> (opens in a new tab)</span>
                  </a>
                </strong>
                <span className="k-xs k-muted">{i.indexed === null ? `The next metrics reading asks ${engine}` : [i.coverage, checked].filter(Boolean).join(' · ')}</span>
              </div>
              {i.indexed === null ? <span className="k-pill k-p-quiet">Not checked</span> : i.indexed ? <span className="k-pill k-p-pub">{yes}</span> : <span className="k-pill k-p-wait">Not yet</span>}
            </div>
          );
        })}
      </div>
    </>
  );
}

/* ---------- Details ---------- */

const TRIGGER_WORDS: Record<string, string> = {
  release: 'started by the release',
  manual: 'started by hand',
  public: 'started when the repo went public',
  enabled: 'started when launches were turned on',
  article: 'written in the app',
};

/** A metric's name as a figure's label: `uniqueVisitors` → Unique visitors */
const metricLabel = (name: string) => {
  const words = name.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, (_, a: string, b: string) => `${a} ${b.toLowerCase()}`);
  return words.charAt(0).toUpperCase() + words.slice(1);
};

export interface DetailsData {
  launch: { repo: string; ref: string; kind: string; trigger: string; createdAt: string; pullRequest?: string | null };
  /** Who approved the drafts held in Shipcast, and when; null while not approved, undefined when not held */
  approval: { by: string; at: string } | null | undefined;
  piecesOut: number;
  repliesSent: number;
  metrics: Array<{ source: string; name: string; value: number; checkedAt: string }>;
  accounts: AccountRow[];
  jobs: JobView[];
}

function JobRow({ job, now }: { job: JobView; now: Date }) {
  const running = job.state === 'running' && !job.queued;
  return (
    <div className="k-row k-sm pub-job">
      <span className="k-grow">{running ? <strong>{job.title}</strong> : job.title}</span>
      {job.state === 'failed' ? (
        <>
          <span className="k-xs pub-fail-word">Failed</span>
          <span className="k-dot k-dot-fail" aria-hidden="true" />
        </>
      ) : job.queued ? (
        <>
          <span className="k-xs k-muted">Waiting for its time</span>
          <span className="k-dot k-dot-sched" aria-hidden="true" />
        </>
      ) : running ? (
        <>
          <span className="k-xs pub-run-word">Running {elapsed(now.getTime() - Date.parse(job.startedAt))}</span>
          <span className="k-dot pub-dot-run" aria-hidden="true" />
        </>
      ) : (
        <>
          <span className="k-xs k-muted">Done</span>
          <span className="k-dot k-dot-pub" aria-hidden="true" />
        </>
      )}
    </div>
  );
}

/** How a launch's jobs stand, in a few words: `6, all done`, `2, 1 running`, `3, 1 failed` */
export function jobsSummary(jobs: readonly JobView[]): string {
  const failed = jobs.filter((j) => j.state === 'failed').length;
  const running = jobs.filter((j) => j.state === 'running' && !j.queued).length;
  const queued = jobs.filter((j) => j.queued).length;
  const parts = [failed && `${failed} failed`, running && `${running} running`, queued && `${queued} waiting`].filter(Boolean);
  return `${jobs.length}, ${parts.length > 0 ? parts.join(', ') : jobs.length === 1 ? 'done' : 'all done'}`;
}

export function DetailsPanel({ data, owner, timezone }: { data: DetailsData; owner: string; timezone: string }) {
  const now = useNow();
  const { launch, metrics, jobs } = data;
  const article = launch.ref.startsWith('article:');
  const sources = [...new Set(metrics.map((m) => m.source))];
  const [source, setSource] = useState(sources[0]);
  const current = sources.includes(source ?? '') ? source : sources[0];
  const values = metrics.filter((m) => m.source === current);
  const followers = data.accounts.find((a) => current && a.channels.includes(current))?.followers;
  const [allJobs, setAllJobs] = useState(false);
  const shownJobs = allJobs ? jobs : jobs.slice(0, 3);
  const approval = data.approval;
  return (
    <div className="k-px k-stack pub-details">
      <section className="k-card" aria-labelledby="about-title">
        <h2 className="k-d k-d30" id="about-title">
          About this launch
        </h2>
        <dl className="k-kv">
          <dt>Repository</dt>
          <dd className="pub-break">{launch.repo}</dd>
          <dt>{article ? 'Article' : 'Release'}</dt>
          <dd className="k-mono pub-break">{launch.ref.replace(/^article:/, '')}</dd>
          <dt>Pack</dt>
          <dd>
            {launch.kind.charAt(0).toUpperCase() + launch.kind.slice(1)}, {TRIGGER_WORDS[launch.trigger] ?? `started by ${launch.trigger}`}
          </dd>
          <dt>Started</dt>
          <dd>{dayTime(launch.createdAt, timezone)}</dd>
          {approval !== undefined && (
            <>
              <dt>Drafts</dt>
              <dd>Kept in Shipcast{approval ? `, approved by ${approval.by === owner ? 'you' : `@${approval.by}`} on ${dayOnly(approval.at, timezone)}` : ', not approved yet'}</dd>
            </>
          )}
          {launch.pullRequest && (
            <>
              <dt>Drafts</dt>
              <dd>
                <a className="pub-break" href={launch.pullRequest} target="_blank" rel="noreferrer">
                  Pull request #{launch.pullRequest.split('/').at(-1)}
                  <span className="visually-hidden"> (opens in a new tab)</span>
                </a>
              </dd>
            </>
          )}
          <dt>Pieces out</dt>
          <dd>{data.piecesOut}</dd>
          {data.repliesSent > 0 && (
            <>
              <dt>Replies sent</dt>
              <dd>
                <Link to="/comments">{data.repliesSent}</Link>
              </dd>
            </>
          )}
        </dl>
      </section>

      {sources.length > 0 && current && (
        <section className="k-card" aria-labelledby="numbers-title">
          <h2 className="k-d k-d30" id="numbers-title">
            Every number
          </h2>
          <div className="k-chips" role="group" aria-label="Where the numbers come from">
            {sources.map((s) => (
              <button key={s} type="button" className={`k-chip${s === current ? ' k-on' : ''}`} aria-pressed={s === current} onClick={() => setSource(s)}>
                <ChannelGlyph channel={s} size={16} />
                {channelTitle(s)}
              </button>
            ))}
          </div>
          {values[0] && <div className="k-xs k-muted">Read {ago(values[0].checkedAt, now, timezone)}</div>}
          <dl className="pub-figures">
            {values.map((v) => (
              <div key={v.name} className="k-stack">
                <dt className="k-xs k-muted">{metricLabel(v.name)}</dt>
                <dd className="k-d k-d30">{number(v.value)}</dd>
              </div>
            ))}
            {followers && (
              <div className="k-stack" title={`From ${followers.from} to ${followers.to}`}>
                <dt className="k-xs k-muted">Followers{followers.change ? `, ${signed(followers.change)} since ${followers.from}` : ''}</dt>
                <dd className="k-d k-d30">{number(followers.now)}</dd>
              </div>
            )}
          </dl>
        </section>
      )}

      {jobs.length > 0 && (
        <section className="k-card" aria-labelledby="jobs-title">
          <div className="k-hrow k-between">
            <h2 className="k-d k-d30" id="jobs-title">
              Jobs
            </h2>
            <span className="k-xs k-muted">{jobsSummary(jobs)}</span>
          </div>
          <div className="k-stack">
            {shownJobs.map((job) => (
              <div key={job.id}>
                <JobRow job={job} now={now} />
                {allJobs && job.log.length > 0 && (
                  <pre className="k-mono k-xs pub-log" aria-label={`The log of ${job.title}`}>
                    {job.log.join('\n')}
                  </pre>
                )}
              </div>
            ))}
            <button type="button" className="pub-linkbtn k-sm" aria-expanded={allJobs} onClick={() => setAllJobs(!allJobs)}>
              {allJobs ? 'Fewer jobs, no logs' : jobs.length === 1 ? 'The job’s log' : `All ${jobs.length} jobs and their logs`}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

/* ---------- Drafting ---------- */

/** A launch while Shipcast drafts it (board LaunchDrafting): the typewriter, its jobs, and what comes next */
export function DraftingView({ jobs, onLeave }: { jobs: JobView[]; onLeave?: ReactNode }) {
  const now = useNow(1000);
  return (
    <>
      <div className="k-px k-stack k-g16 pub-drafting">
        <div className="pub-drafting-art" aria-hidden="true">
          <Typewriter width={240} />
        </div>
        <h2 className="k-d k-d30">Drafting…</h2>
        <p className="k-muted pub-drafting-text">Shipcast is reading the code and writing each piece. The drafts show here when they are ready; you can leave this page.</p>
      </div>
      <div className="k-px pub-drafting-jobs">
        <div className="k-card pub-jobs-card">
          {jobs.map((job) => (
            <JobRow key={job.id} job={job} now={now} />
          ))}
          <div className="k-row k-sm k-muted">
            <span className="k-grow">Open the review</span>
            <span className="k-xs">Next</span>
            <span className="k-dot k-dot-quiet" aria-hidden="true" />
          </div>
        </div>
      </div>
      <p className="k-px k-xs k-muted pub-drafting-note">A notice in the bell says when it waits for you.</p>
      {onLeave}
    </>
  );
}

/* ---------- Failed ---------- */

/** A launch that failed before anything went out (board LaunchFailed): why, and the way to try again */
export function FailedCard({ problem, posted, relaunch, busy, detailsSearch }: { problem: string; posted: boolean; relaunch: (() => void) | null; busy: boolean; detailsSearch: () => void }) {
  return (
    <div className="k-px pub-failed">
      <div className="k-card k-fail pub-failed-card">
        <div className="k-hrow k-g12 pub-failed-top">
          <div className="pub-failed-art" aria-hidden="true">
            <PublishFailed width={110} />
          </div>
          <div className="k-stack k-g4">
            <strong className="pub-failed-title">{posted ? 'The launch failed part of the way.' : 'The launch failed before anything went out.'}</strong>
            <span className="k-sm k-muted">{posted ? 'What went out stays; the channels show which failed.' : relaunch ? 'Nothing was posted. You can launch it again as it is.' : 'Nothing was posted.'}</span>
          </div>
        </div>
        <div className="k-mono k-xs pub-problem">{problem}</div>
        {relaunch && (
          <button type="button" className="k-btn k-pri k-full" disabled={busy} onClick={relaunch}>
            <Icon name="retry" size={18} />
            {busy ? 'Launching…' : 'Launch it again'}
          </button>
        )}
        <button type="button" className="pub-linkbtn k-sm pub-failed-log" onClick={detailsSearch}>
          See the job’s log in Details
        </button>
      </div>
    </div>
  );
}
