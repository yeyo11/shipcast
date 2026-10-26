import { createFileRoute, Link, notFound, useRouter } from '@tanstack/react-router';
import { useEffect, useState, type ReactNode } from 'react';
import { Jobs } from '../../../components/Jobs';
import { Channels, metricWords } from '../../../components/launch/Channels';
import { ChannelIcon, DailyBars, TotalsRow } from '../../../components/launch/Glance';
import { AccountNumbers } from '../../../components/launch/Numbers';
import { EmptyDrafts } from '../../../components/illustrations';
import { Empty } from '../../../components/PageHead';
import { PageToolbar, ToolbarAction } from '../../../components/PageToolbar';
import { ChevronIcon, ExternalIcon, SendIcon } from '../../../components/ui/icons';
import { useToast } from '../../../components/Toasts';
import { Notice, number, Pill, when } from '../../../components/ui';
import { Accordion, AccordionItem, Collapsible } from '../../../components/ui/Collapsible';
import { Tabs } from '../../../components/ui/Tabs';
import { launchDateLabel } from '../../../server/launch-summary';
import { approveDrafts, getLaunch, publishAgain, saveDraft } from '../../../server/launches.functions';
import { zonedLabel } from '../../../server/pieces';
import { CHANNEL_NAMES } from '../../../server/view';

const TABS = ['channels', 'content', 'search', 'details'] as const;
type TabId = (typeof TABS)[number];

interface LaunchSearch {
  tab?: TabId;
  channel?: string;
}

export const Route = createFileRoute('/_app/launches/$id')({
  // The tab and the channel live in the address, so a reload, a shared link or Back lands on the same view
  validateSearch: (search: Record<string, unknown>): LaunchSearch => ({
    ...(typeof search.tab === 'string' && (TABS as readonly string[]).includes(search.tab) && { tab: search.tab as TabId }),
    ...(typeof search.channel === 'string' && search.channel !== '' && { channel: search.channel }),
  }),
  loader: async ({ params }) => {
    const data = await getLaunch({ data: Number(params.id) });
    if (!data) throw notFound();
    return data;
  },
  head: ({ loaderData }) => ({ meta: [{ title: `${loaderData?.launch.repo ?? 'Launch'} · Shipcast` }] }),
  component: LaunchPage,
});

type Data = Awaited<ReturnType<typeof getLaunch>> & {};
type Review = Exclude<Data['review'], null | { error: string }>;
type DraftView = Review['drafts'][number];

/** One text of the launch as a folded row, opened on demand; editable while its pull request is open */
function DraftEditor({ launchId, draft, editable }: { launchId: number; draft: DraftView; editable: boolean }) {
  const router = useRouter();
  const [content, setContent] = useState(draft.content ?? '');
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const changed = content !== (draft.content ?? '');
  return (
    <AccordionItem
      value={draft.path}
      className="draft"
      triggerClassName="draft-trigger"
      summary={
        <>
          <span className="draft-title">{draft.label}</span>
          <span className="muted mono break draft-path">{draft.path}</span>
        </>
      }
    >
      {editable ? (
        <>
          <label className="visually-hidden" htmlFor={draft.path}>
            {draft.label}
          </label>
          <textarea id={draft.path} className={`textarea mono${draft.kind === 'article' ? ' tall' : ''}`} value={content} onChange={(e) => setContent(e.target.value)} />
          <div className="row">
            <button
              className="btn btn-small"
              disabled={!changed || busy}
              onClick={async () => {
                setBusy(true);
                const answer = await saveDraft({ data: { id: launchId, path: draft.path, content } });
                setBusy(false);
                if (answer.ok) toast.done(`${draft.label} saved`, 'The edit is a commit on the pull request: it is what gets published.');
                else toast.fail(answer.problem);
                if (answer.ok) await router.invalidate();
              }}
            >
              {busy ? 'Saving…' : 'Save this edit'}
            </button>
          </div>
        </>
      ) : (
        <div className="preview">{draft.content}</div>
      )}
    </AccordionItem>
  );
}

/**
 * What the launch is, the accounts it went out with, its last reading of every number and its jobs:
 * four cards in the app's card skin, the facts as label and value, every number as a figure under
 * its source's glyph
 */
function Details({ data }: { data: Data }) {
  const { launch, pieces, metrics, jobs } = data;
  const replies = Object.values(pieces.replies).reduce((a, b) => a + b, 0);
  const bySource = new Map<string, typeof metrics>();
  for (const m of metrics) bySource.set(m.source, [...(bySource.get(m.source) ?? []), m]);
  const out = pieces.rows.filter((r) => r.status === 'live' || r.status === 'edited').length;
  return (
    <div className="details">
      <section className="lcard dcard" aria-labelledby="props-title">
        <h2 className="dcard-title" id="props-title">
          About this launch
        </h2>
        <dl className="dfacts">
          <div>
            <dt>State</dt>
            <dd>
              <Pill tone={launch.state.tone}>{launch.state.label}</Pill>
            </dd>
          </div>
          <div>
            <dt>Repository</dt>
            <dd className="break">{launch.repo}</dd>
          </div>
          <div>
            <dt>{launch.ref.startsWith('article:') ? 'Article' : 'Release'}</dt>
            <dd className="mono break">{launch.ref.replace(/^article:/, '')}</dd>
          </div>
          <div>
            <dt>Pack</dt>
            <dd>
              {launch.kind}, started {launch.trigger === 'manual' ? 'by hand' : `by ${launch.trigger}`}
            </dd>
          </div>
          <div>
            <dt>Started</dt>
            <dd>{when(launch.createdAt)}</dd>
          </div>
          {launch.pullRequest && (
            <div>
              <dt>Drafts</dt>
              <dd>
                <a className="break" href={launch.pullRequest} target="_blank" rel="noreferrer">
                  Pull request #{launch.pullRequest.split('/').at(-1)}
                  <span className="visually-hidden"> (opens in a new tab)</span>
                </a>
              </dd>
            </div>
          )}
          <div>
            <dt>Pieces out</dt>
            <dd>{out}</dd>
          </div>
          {replies > 0 && (
            <div>
              <dt>Replies sent</dt>
              <dd>
                <Link to="/comments">{replies}</Link>
              </dd>
            </div>
          )}
        </dl>
      </section>
      <AccountNumbers accounts={pieces.accounts} />
      {metrics.length > 0 && (
        <section className="lcard dcard details-wide" aria-labelledby="latest-title">
          <h2 className="dcard-title" id="latest-title">
            Every number, last reading
          </h2>
          <div className="dsources">
            {[...bySource].map(([source, values]) => (
              <section className="dsource" key={source} aria-label={CHANNEL_NAMES[source] ?? source}>
                <header className="dsource-head">
                  <ChannelIcon channel={source} size={18} />
                  <strong>{CHANNEL_NAMES[source] ?? source}</strong>
                  <span className="muted">read {when(values[0]!.takenAt)}</span>
                </header>
                <dl className="post-numbers dsource-numbers">
                  {values.map((v) => (
                    <div key={v.name}>
                      <dt>{metricWords(v.name)}</dt>
                      <dd>{number(v.value)}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>
        </section>
      )}
      {jobs.length > 0 && (
        <section className="lcard dcard details-wide" aria-labelledby="jobs-title">
          <h2 className="dcard-title" id="jobs-title">
            Jobs of this launch
          </h2>
          <Jobs jobs={jobs} />
        </section>
      )}
    </div>
  );
}

function SearchEngines({ index }: { index: Data['index'] }) {
  if (index.length === 0) return <p className="muted">No article of this launch is on the blog, so there is nothing for a search engine to index.</p>;
  return (
    <table className="table table-stack">
      <tbody>
        {index.map((i) => (
          <tr key={`${i.engine} ${i.url}`}>
            <th scope="row">
              {i.engine === 'bing' ? 'Bing' : 'Google'},{' '}
              <a href={i.url} target="_blank" rel="noreferrer">
                {i.lang === 'es' ? 'Spanish' : 'English'}
              </a>
            </th>
            <td>
              {i.indexed === null ? (
                <span className="muted">Not checked yet: the next metrics reading asks Google</span>
              ) : (
                <>
                  <Pill tone={i.indexed ? 'published' : 'waiting'}>{i.engine === 'bing' ? (i.indexed ? 'Crawled' : 'Not crawled yet') : i.indexed ? 'Indexed' : 'Not indexed yet'}</Pill>{' '}
                  <span className="muted">{i.coverage}</span>
                </>
              )}
            </td>
            <td className="muted">{i.checkedAt ? `checked ${when(i.checkedAt)}` : ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function LaunchPage() {
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const { launch, review, index, jobs, pieces, numbers } = data;
  const running = jobs.some((j) => j.state === 'running') || launch.status === 'generating';
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => router.invalidate(), 5000);
    return () => clearInterval(timer);
  }, [running, router]);

  const reviewOk = review && !('error' in review) ? review : undefined;
  const open = reviewOk?.pullRequest.state === 'open';
  const texts = reviewOk?.drafts.filter((d) => d.kind === 'article' || d.kind === 'channel') ?? [];
  const media = reviewOk?.drafts.filter((d) => d.kind === 'image' || d.kind === 'video') ?? [];
  const timezone = pieces.scheduling.timezone;
  const hasChannels = pieces.rows.length > 0 || launch.failures.length > 0 || pieces.scheduling.channels.length > 0;
  // A launch with nothing out yet opens on its drafts, the only thing there is to read
  const tab: TabId = search.tab ?? (hasChannels ? 'channels' : 'content');
  const go = (next: LaunchSearch) => navigate({ search: (prev) => ({ ...prev, ...next }), replace: true, resetScroll: false });
  const article = pieces.rows.find((r) => r.channel === 'blog' && r.url && (r.status === 'live' || r.status === 'edited'));
  const shown = Object.values(numbers.totals).some((n) => n > 0) || pieces.rows.length > 0;

  // The quiet line: what waits on the owner, linked, in the text's own size, never a block
  const quiet: ReactNode[] = [];
  if (data.waitingComments > 0) {
    quiet.push(
      <Link key="comments" to="/comments">
        {data.waitingComments === 1 ? '1 comment to answer' : `${data.waitingComments} comments to answer`}
      </Link>,
    );
  }
  for (const c of pieces.scheduling.channels) {
    if (!c.scheduled?.scheduledAt) continue;
    quiet.push(
      <Link key={c.channel} to="/launches/$id" params={{ id: String(launch.id) }} search={{ tab: 'channels', channel: c.channel }} replace resetScroll={false}>
        {CHANNEL_NAMES[c.channel] ?? c.channel} goes out {zonedLabel(c.scheduled.scheduledAt, timezone)}
      </Link>,
    );
  }
  for (const j of jobs.filter((x) => x.state === 'running')) {
    quiet.push(
      <Link key={j.id} to="/launches/$id" params={{ id: String(launch.id) }} search={{ tab: 'details' }} replace resetScroll={false}>
        {j.title}…
      </Link>,
    );
  }

  const approve = async () => {
    setBusy(true);
    const answer = await approveDrafts({ data: launch.id });
    setBusy(false);
    if (answer.ok) toast.done('Approved', 'The pull request is merged; the blog deploys, then every channel publishes.');
    else toast.fail(answer.problem);
    await router.invalidate();
  };

  return (
    <>
      <header className="lhead">
        <div className="lhead-text">
          <h1 className="ph">
            {launch.ref.startsWith('article:') ? 'Article' : launch.repo.split('/')[1]}
            {!launch.ref.startsWith('article:') && <span className="lhead-ref"> {launch.ref}</span>}
          </h1>
          <p className="muted">
            {launch.repo} · {launch.kind} · launched {launchDateLabel(launch.createdAt, timezone)}
          </p>
        </div>
      </header>
      <PageToolbar
        label="This launch"
        controls={
          <>
            <Link className="tb-back" to="/">
              <ChevronIcon dir="left" size={16} /> All launches
            </Link>
            <Pill tone={launch.state.tone}>{launch.state.label}</Pill>
          </>
        }
        actions={
          <>
            {article?.url && (
              <ToolbarAction
                label="Open the article"
                icon={<ExternalIcon />}
                render={<a href={article.url} target="_blank" rel="noreferrer" aria-label="Open the article (opens in a new tab)" />}
              />
            )}
            {launch.status === 'drafted' && !open && !running && (
              <ToolbarAction
                primary
                label="Publish what is pending"
                icon={<SendIcon />}
                onClick={async () => {
                  const answer = await publishAgain({ data: { id: launch.id } });
                  if (answer.ok) toast.done('Publishing what is pending');
                  else toast.fail(answer.problem);
                  await router.invalidate();
                }}
              />
            )}
          </>
        }
      />

      {data.fakeNetworks && (
        <Notice tone="wait">
          <strong>A preview with fake networks.</strong> Edits, deletes and times change this copy of the data only: no request reaches a network, and nothing is written to GitHub.
        </Notice>
      )}
      {launch.problem && (
        <Notice tone="bad">
          <strong>The launch failed.</strong>
          <div className="preview">{launch.problem}</div>
        </Notice>
      )}

      {open && (
        <div className="strip strip-yellow" role="region" aria-label="Waiting for you">
          <strong className="strip-title">Waiting for you</strong>
          <div className="row">
            {reviewOk && (
              <a className="btn btn-small" href={reviewOk.pullRequest.url} target="_blank" rel="noreferrer" style={{ color: '#000', borderColor: '#000' }}>
                Open the pull request
              </a>
            )}
            <button className="btn btn-primary btn-small" disabled={busy} onClick={approve} title="Approving merges the pull request: the blog publishes, then every approved channel">
              {busy ? 'Approving…' : `Approve and publish ${texts.filter((t) => t.kind === 'channel').length + 1} pieces`}
            </button>
          </div>
        </div>
      )}

      {shown && (
        <div className="hero-numbers">
          <TotalsRow totals={numbers.totals} />
          <DailyBars days={numbers.daily} launchedAt={launch.createdAt} />
        </div>
      )}
      {quiet.length > 0 && (
        <p className="quiet">
          {quiet.map((item, i) => (
            <span key={i}>
              {i > 0 && <span aria-hidden="true">·</span>}
              {item}
            </span>
          ))}
        </p>
      )}

      <Tabs<TabId>
        label="This launch"
        value={tab}
        onValueChange={(next) => go({ tab: next })}
        tabs={[
          {
            value: 'channels',
            label: 'Channels',
            panel: (
              <Channels
                launchId={launch.id}
                repo={launch.repo}
                rows={pieces.rows}
                replies={pieces.replies}
                drafts={reviewOk?.drafts ?? []}
                capabilities={pieces.capabilities}
                failures={launch.failures}
                scheduling={pieces.scheduling}
                channel={search.channel}
                onChannel={(channel) => go({ tab: 'channels', channel })}
                numbers={numbers.channels}
              />
            ),
          },
          {
            value: 'content',
            label: 'Content',
            panel: (
              <div className="content-tab">
                {review && 'error' in review && <Notice tone="bad">Could not read the drafts: {review.error}</Notice>}
                {texts.length === 0 && launch.posts.length === 0 && !launch.problem && (
                  <Empty art={<EmptyDrafts width={220} />} title={running ? 'Drafting…' : 'No drafts here'}>
                    {running
                      ? 'Shipcast is reading the code and writing each piece; the drafts show here when they are ready.'
                      : reviewOk
                        ? 'The pull request has no texts to review.'
                        : 'Nothing was drafted for this launch yet.'}
                  </Empty>
                )}
                {texts.length > 0 && (
                  <section aria-labelledby="texts-title">
                    <h2 className="tab-title" id="texts-title">
                      {open ? 'The drafts' : 'What went out'}
                    </h2>
                    <Accordion className="drafts">
                      {texts.map((d) => (
                        <DraftEditor key={d.path} launchId={launch.id} draft={d} editable={open} />
                      ))}
                    </Accordion>
                  </section>
                )}
                {media.length > 0 && (
                  <Collapsible
                    className="draft"
                    triggerClassName="draft-trigger"
                    summary={
                      <>
                        <span className="draft-title">Media</span>
                        <span className="muted draft-path">
                          {media.length} {media.length === 1 ? 'file' : 'files'}
                        </span>
                      </>
                    }
                  >
                    <div className="thumbs">
                      {media.map((m) =>
                        m.kind === 'video' ? (
                          <video key={m.path} src={m.url} controls muted style={{ height: 180, borderRadius: 12 }} />
                        ) : (
                          <a key={m.path} href={m.url} target="_blank" rel="noreferrer">
                            <img src={m.url} alt={m.label} loading="lazy" />
                          </a>
                        ),
                      )}
                    </div>
                  </Collapsible>
                )}
                {texts.length === 0 && media.length === 0 && launch.posts.length > 0 && <p className="muted">The drafts of this launch could not be read from its pull request.</p>}
              </div>
            ),
          },
          { value: 'search', label: 'Search engines', panel: <SearchEngines index={index} /> },
          { value: 'details', label: 'Details', panel: <Details data={data} /> },
        ]}
      />
    </>
  );
}
