import { createFileRoute, Link, notFound, useRouter } from '@tanstack/react-router';
import { useEffect, useState, type ReactNode } from 'react';
import { Jobs } from '../../../components/Jobs';
import { useLiveEnabled, useLiveRoute } from '../../../components/live/Live';
import { Channels, metricWords } from '../../../components/launch/Channels';
import { ChannelIcon, DailyBars, TotalsRow } from '../../../components/launch/Glance';
import { DeleteLaunch } from '../../../components/launch/DeleteLaunch';
import { AccountNumbers } from '../../../components/launch/Numbers';
import { Automation, EmptyDrafts, PublishFailed, Shipped, WaitingForYou } from '../../../components/illustrations';
import { Empty, PageHead } from '../../../components/PageHead';
import { PageToolbar, ToolbarAction } from '../../../components/PageToolbar';
import { ChevronIcon, CloseIcon, ExternalIcon, SendIcon } from '../../../components/ui/icons';
import { useToast } from '../../../components/Toasts';
import { Notice, number, Pill, when } from '../../../components/ui';
import { Accordion, AccordionItem, Collapsible } from '../../../components/ui/Collapsible';
import { Tabs } from '../../../components/ui/Tabs';
import { launchDateLabel } from '../../../server/launch-summary';
import { approveDrafts, findSitePreview, getLaunch, launchRepo, previewOnSite, publishAgain, refreshDrafts, saveDraft } from '../../../server/launches.functions';
import { zonedLabel } from '../../../server/pieces';
import { CHANNEL_NAMES } from '../../../server/view';

const TABS = ['channels', 'content', 'search', 'details'] as const;
type TabId = (typeof TABS)[number];

interface LaunchSearch {
  tab?: TabId;
  channel?: string;
}

/** The banner's illustration tells where the launch is: shipped, waiting, failed, on its way or set aside */
function LaunchArt({ status }: { status: string }) {
  if (status === 'published') return <Shipped width={200} />;
  if (status === 'drafted') return <WaitingForYou width={200} />;
  if (status === 'failed') return <PublishFailed width={200} />;
  if (status === 'skipped') return <EmptyDrafts width={200} />;
  return <Automation width={200} />;
}

export const Route = createFileRoute('/_app/launches/$id')({
  // The tab and the channel live in the address, so a reload, a shared link or Back lands on the same view
  validateSearch: (search: Record<string, unknown>): LaunchSearch => ({
    ...(typeof search.tab === 'string' && (TABS as readonly string[]).includes(search.tab) && { tab: search.tab as TabId }),
    ...(typeof search.channel === 'string' && search.channel !== '' && { channel: search.channel }),
  }),
  // A change of tab or channel is a new address but the same data: kept for 30 s instead of read
  // again on every click; an action still reloads it at once (router.invalidate)
  staleTime: 30_000,
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

/**
 * An article as the blog would show it (docs/app-review.md): its title, description and launch image
 * over the body, rendered on the server with any HTML in it shown as text
 */
function ArticlePreview({ preview }: { preview: NonNullable<DraftView['preview']> }) {
  return (
    <article className="article-preview" aria-label="The article as the blog shows it">
      <h3 className="article-preview-title">{preview.title}</h3>
      {preview.description && <p className="article-preview-lead">{preview.description}</p>}
      {preview.image && <img className="article-preview-image" src={preview.image} alt={preview.imageAlt ?? ''} loading="lazy" />}
      <div className="article-preview-body" dangerouslySetInnerHTML={{ __html: preview.html }} />
    </article>
  );
}

/**
 * One text of the launch as a folded row, opened on demand; editable while its pull request is open,
 * or for a launch Shipcast holds while it is drafted (`app`), where an article opens on its preview
 */
function DraftEditor({ launchId, draft, editable, app }: { launchId: number; draft: DraftView; editable: boolean; app: boolean }) {
  const router = useRouter();
  const [content, setContent] = useState(draft.content ?? '');
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(!draft.preview);
  const changed = content !== (draft.content ?? '');
  return (
    <AccordionItem
      value={draft.path}
      className="draft"
      triggerClassName="draft-trigger"
      summary={
        <>
          <span className="draft-title">{draft.label}</span>
          {draft.approved !== undefined && <Pill tone={draft.approved ? 'published' : 'waiting'}>{draft.approved ? 'Approved' : 'Not approved'}</Pill>}
          <span className="muted mono break draft-path">{draft.path}</span>
        </>
      }
    >
      {draft.preview && (
        <div className="row">
          <button type="button" className="btn btn-small" aria-pressed={!editing} onClick={() => setEditing(false)}>
            Preview
          </button>
          <button type="button" className="btn btn-small" aria-pressed={editing} onClick={() => setEditing(true)}>
            {editable ? 'Edit the text' : 'The text'}
          </button>
        </div>
      )}
      {draft.preview && !editing ? (
        <ArticlePreview preview={draft.preview} />
      ) : editable ? (
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
                if (answer.ok) toast.done(`${draft.label} saved`, app ? 'Saved as a new version: it goes out once it is approved.' : 'The edit is a commit on the pull request: it is what gets published.');
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

/** How a launch started, in words */
const TRIGGER_WORDS: Record<string, string> = {
  release: 'started by a release',
  manual: 'started by hand',
  public: 'started when the repo went public',
  enabled: 'started when launches were turned on',
  article: 'written in the app',
};

/**
 * What the launch is, the accounts it went out with, its last reading of every number and its jobs:
 * four cards in the app's card skin, the facts as label and value, every number as a figure under
 * its source's glyph
 */
function Details({ data }: { data: Data }) {
  const { launch, pieces, metrics, jobs } = data;
  const review = data.review && !('error' in data.review) ? data.review : undefined;
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
              {launch.kind}, {TRIGGER_WORDS[launch.trigger] ?? `started by ${launch.trigger}`}
            </dd>
          </div>
          <div>
            <dt>Started</dt>
            <dd>{when(launch.createdAt)}</dd>
          </div>
          {review?.app && (
            <div>
              <dt>Drafts</dt>
              <dd>
                Kept in Shipcast
                {review.app.approval ? `, approved by ${review.app.approval.by} ${when(review.app.approval.at)}` : ', not approved yet'}
              </dd>
            </div>
          )}
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
                  <span className="muted">read {when(values[0]!.checkedAt)}</span>
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
  // With launch-delete: the dialog that says what deleting would do (docs/launch-delete.md)
  const [deleting, setDeleting] = useState(false);
  const { launch, review, index, jobs, pieces, numbers } = data;
  const running = jobs.some((j) => j.state === 'running' && !j.queued) || launch.status === 'generating';
  // Live (realtime-ui): this launch's own events reload it, whether or not something runs
  const live = useLiveEnabled();
  useLiveRoute(Route.id, live ? [`launch:${launch.id}`, `post:${launch.id}`, `job:${launch.id}`, `comment:${launch.id}`, `metrics:${launch.id}`] : null);
  useEffect(() => {
    if (live || !running) return;
    // Never a second read while one is still on its way: they used to pile up and be cut ("Failed to fetch")
    const timer = setInterval(() => {
      if (router.state.status !== 'pending') void router.invalidate();
    }, 5000);
    return () => clearInterval(timer);
  }, [live, running, router]);

  const reviewOk = review && !('error' in review) ? review : undefined;
  // A launch Shipcast holds is reviewed here (docs/app-review.md): editable while drafted, waiting for
  // the owner while nothing is approved or something changed since the approval
  const app = reviewOk?.app;
  const waitingChannels = app ? Object.keys(app.waiting) : [];
  const editable = app ? app.open : reviewOk?.pullRequest?.state === 'open';
  const open = app ? app.open && (app.approval === null || waitingChannels.length > 0) : editable;
  const texts = reviewOk?.drafts.filter((d) => d.kind === 'article' || d.kind === 'channel') ?? [];
  const media = reviewOk?.drafts.filter((d) => d.kind === 'image' || d.kind === 'video') ?? [];
  const timezone = pieces.scheduling.timezone;
  const hasChannels = pieces.rows.length > 0 || launch.failures.length > 0 || pieces.scheduling.channels.length > 0;
  // A launch with nothing out yet opens on its drafts, the only thing there is to read; one that
  // failed before drafting has none, so it opens on its details, where the job's log says why
  const failedEmpty = Boolean(launch.problem) && !hasChannels && texts.length === 0;
  const tab: TabId = search.tab ?? (hasChannels ? 'channels' : failedEmpty ? 'details' : 'content');
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
  // A scheduled piece's job waits in the queue until its time: the line above already says when
  for (const j of jobs.filter((x) => x.state === 'running' && !x.queued)) {
    quiet.push(
      <Link key={j.id} to="/launches/$id" params={{ id: String(launch.id) }} search={{ tab: 'details' }} replace resetScroll={false}>
        {j.title}…
      </Link>,
    );
  }

  // A failed release published nothing, so launching it again retries it (claimManual); an article is written again in Write
  const relaunch = async () => {
    setBusy(true);
    const answer = await launchRepo({ data: { repo: launch.repo, ref: launch.ref, direct: false } }).catch((error: unknown) => ({
      ok: false as const,
      problem: error instanceof Error ? error.message : String(error),
    }));
    setBusy(false);
    if (answer.ok) toast.done(`Drafting ${launch.repo.split('/')[1]} ${launch.ref}`, 'The analysis takes a few minutes; it shows here while it runs.');
    else toast.fail(answer.problem);
    await router.invalidate();
  };

  // With the drafts snapshot the page shows the pull request as last read, and can read it again
  const readAt = 'draftsReadAt' in data ? data.draftsReadAt : undefined;
  const refresh = async () => {
    setBusy(true);
    const answer = await refreshDrafts({ data: launch.id }).catch((error: unknown) => ({ ok: false as const, problem: error instanceof Error ? error.message : String(error) }));
    setBusy(false);
    if (!answer.ok) toast.fail(answer.problem);
    await router.invalidate();
  };

  const approve = async () => {
    setBusy(true);
    const answer = await approveDrafts({ data: launch.id });
    setBusy(false);
    if (answer.ok) toast.done('Approved', app ? 'The article and its media go to the site in one commit; once it is live, every approved channel publishes.' : 'The pull request is merged; the blog deploys, then every channel publishes.');
    else toast.fail(answer.problem);
    await router.invalidate();
  };

  // The real site's preview: asked for on demand, its address read from its pull request when the owner asks
  const sitePreview = async (find: boolean) => {
    setBusy(true);
    const answer = await (find ? findSitePreview : previewOnSite)({ data: launch.id }).catch((error: unknown) => ({ ok: false as const, problem: error instanceof Error ? error.message : String(error) }));
    setBusy(false);
    if (!answer.ok) toast.fail(answer.problem);
    else if (!find) toast.done('Preview asked for', 'The site builds it in a few minutes; its address shows here once it is up.');
    else if (!answer.preview.url) toast.done('Not up yet', 'The site is still building the preview.');
    await router.invalidate();
  };
  const preview = app?.preview;
  const previewReady = Boolean(preview?.url && preview.urlSha && preview.sha.startsWith(preview.urlSha));

  return (
    <>
      <PageHead
        title={
          <>
            {launch.ref.startsWith('article:') ? 'Article' : launch.repo.split('/')[1]}
            {!launch.ref.startsWith('article:') && <span className="lhead-ref"> {launch.ref}</span>}
          </>
        }
        art={<LaunchArt status={launch.status} />}
      >
        {launch.repo} · {launch.kind} · launched {launchDateLabel(launch.createdAt, timezone)}
      </PageHead>
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
            {data.deletable && !launch.deletedAt && <ToolbarAction label="Delete launch" icon={<CloseIcon />} disabled={running} onClick={() => setDeleting(true)} />}
          </>
        }
      />
      {data.deletable && (
        <DeleteLaunch
          launchId={launch.id}
          open={deleting}
          onOpenChange={setDeleting}
          onDeleted={async () => {
            await router.invalidate();
            await router.navigate({ to: '/' });
          }}
        />
      )}
      {launch.deletedAt && (
        <Notice tone="wait">
          <strong>Deleted on {when(launch.deletedAt)}.</strong> It is hidden from the lists and nothing more of it goes out; the posts that were kept stay on their networks.
        </Notice>
      )}

      {data.fakeNetworks && (
        <Notice tone="wait">
          <strong>A preview with fake networks.</strong> Edits, deletes and times change this copy of the data only: no request reaches a network, and nothing is written to GitHub.
        </Notice>
      )}
      {launch.problem && (
        <Notice tone="bad">
          <strong>The launch failed.</strong>
          <div className="preview">{launch.problem}</div>
          {!launch.ref.startsWith('article:') && launch.posts.length === 0 && (
            <button type="button" className="btn btn-small" disabled={busy || running} onClick={relaunch}>
              Launch it again
            </button>
          )}
        </Notice>
      )}

      {open && (
        <div className="strip strip-yellow" role="region" aria-label="Waiting for you">
          <strong className="strip-title">Waiting for you</strong>
          {app?.approval && waitingChannels.length > 0 && (
            <p className="strip-text">
              Changed since it was approved: {waitingChannels.map((c) => CHANNEL_NAMES[c] ?? c).join(', ')}. Approve again to send {waitingChannels.length === 1 ? 'it' : 'them'}.
            </p>
          )}
          <div className="row">
            {app && (
              <button className="btn btn-small" disabled={busy} onClick={() => sitePreview(false)} title="Puts the article and its media on a preview branch of the launches repo, which the site deploys to its own address">
                {preview ? 'Update the site preview' : 'Preview on the real site'}
              </button>
            )}
            {reviewOk?.pullRequest && (
              <a className="btn btn-small" href={reviewOk.pullRequest.url} target="_blank" rel="noreferrer" style={{ color: '#000', borderColor: '#000' }}>
                Open the pull request
              </a>
            )}
            <button
              className="btn btn-primary btn-small"
              disabled={busy}
              onClick={approve}
              title={app ? 'Approving records the drafts as they are now: the article goes to the site, then every approved channel' : 'Approving merges the pull request: the blog publishes, then every approved channel'}
            >
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
                {readAt !== undefined && (launch.pullRequest || readAt) && (
                  <p className="quiet">
                    <span>{readAt ? `Drafts read from GitHub ${when(readAt)}` : 'The drafts have not been read from GitHub yet'}</span>
                    <span aria-hidden="true">·</span>
                    <button className="btn btn-small" disabled={busy} onClick={refresh}>
                      Refresh from GitHub
                    </button>
                  </p>
                )}
                {review && 'error' in review && <Notice tone="bad">Could not read the drafts: {review.error}</Notice>}
                {preview && (
                  <p className="quiet">
                    {previewReady && preview.url ? (
                      <a href={preview.url} target="_blank" rel="noreferrer">
                        The preview on the real site
                        <span className="visually-hidden"> (opens in a new tab)</span>
                      </a>
                    ) : (
                      <span>Site preview asked for {when(preview.at)}; the site builds it in a few minutes</span>
                    )}
                    <span aria-hidden="true">·</span>
                    <button className="btn btn-small" disabled={busy} onClick={() => sitePreview(true)}>
                      {previewReady ? 'Check again' : 'Find its address'}
                    </button>
                  </p>
                )}
                {failedEmpty && (
                  <Empty art={<EmptyDrafts width={220} />} title="Nothing was drafted">
                    The launch failed before its drafts were written: the reason is above, and the job’s log is in Details.
                  </Empty>
                )}
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
                      {editable ? 'The drafts' : 'What went out'}
                    </h2>
                    <Accordion className="drafts">
                      {texts.map((d) => (
                        <DraftEditor key={d.path} launchId={launch.id} draft={d} editable={editable} app={Boolean(app)} />
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
