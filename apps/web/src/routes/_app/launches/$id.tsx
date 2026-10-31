import { createFileRoute, getRouteApi, notFound, useRouter } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useLiveEnabled, useLiveRoute } from '../../../components/live/Live';
import { Channels } from '../../../components/launch/Channels';
import { ChannelList, ViewsCard } from '../../../components/launch/ChannelList';
import { ago, dayOnly } from '../../../components/launch/dates';
import { LaunchActionsProvider, useLaunchActions } from '../../../components/launch/LaunchActions';
import { LaunchHead, LaunchTabs } from '../../../components/launch/LaunchHead';
import { DetailsPanel, DraftingView, FailedCard, SearchPanel, useNow } from '../../../components/launch/LaunchPanels';
import { pillClass, withScheduled } from '../../../components/launch/published';
import { EmptyDrafts } from '../../../components/illustrations';
import { Empty } from '../../../components/PageHead';
import { useToast } from '../../../components/Toasts';
import { Notice, Pill, when } from '../../../components/ui';
import { Accordion, AccordionItem, Collapsible } from '../../../components/ui/Collapsible';
import { approveDrafts, findSitePreview, getLaunch, launchRepo, previewOnSite, refreshDrafts, saveDraft } from '../../../server/launches.functions';
import { CHANNEL_NAMES } from '../../../server/view';

const appRoute = getRouteApi('/_app');

const TABS = ['channels', 'content', 'search', 'details'] as const;
type TabId = (typeof TABS)[number];

interface LaunchSearch {
  tab?: TabId;
  channel?: string;
}

/** The banner's illustration tells where the launch is: shipped, waiting, failed, on its way or set aside */
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

function LaunchPage() {
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
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
  const articleUrl = pieces.rows.find((r) => r.channel === 'blog' && r.url && (r.status === 'live' || r.status === 'edited'));
  const shown = Object.values(numbers.totals).some((n) => n > 0) || pieces.rows.length > 0;
  const article = launch.ref.startsWith('article:');
  const now = useNow();
  const owner = appRoute.useLoaderData().login;

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
    // The versions on screen: a draft changed since the page was read is refused, not approved unseen
    const answer = await approveDrafts({ data: { id: launch.id, ...(app && { versions: app.versions }) } });
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

  const shortName = article ? 'Article' : launch.repo.split('/')[1] ?? launch.repo;
  const version = article ? null : launch.ref;
  const drafting = (launch.status === 'generating' || launch.status === 'detected') && !search.tab;
  const failedView = failedEmpty && !search.tab;
  const meta = drafting
    ? `${launch.repo} · started ${ago(launch.createdAt, now, timezone)} ${STARTED_BY[launch.trigger] ?? `by ${launch.trigger}`}`
    : open
      ? `${launch.repo} · drafted ${ago(launch.createdAt, now, timezone)}`
      : `${launch.repo} · ${dayOnly(launch.createdAt, timezone)}`;
  const out = pieces.rows.filter((r) => r.status === 'live' || r.status === 'edited').length;

  return (
    <LaunchActionsProvider
      launchId={launch.id}
      name={shortName.charAt(0).toUpperCase() + shortName.slice(1)}
      version={version}
      rows={pieces.rows}
      drafts={reviewOk?.drafts ?? []}
      timezone={timezone}
      held={Boolean(app)}
      articleUrl={articleUrl?.url ?? null}
      deletable={data.deletable && !launch.deletedAt}
      pending={launch.status === 'drafted' && !open}
      running={running}
      onDeleted={async () => {
        await router.invalidate();
        await router.navigate({ to: '/' });
      }}
    >
      <div className="pub-page">
        <Head name={shortName} version={version} pill={{ label: launch.state.label, className: pillClass(launch.state.tone, launch.status) }} meta={meta} menu={!drafting} />

        {launch.deletedAt && (
          <div className="k-px pub-notice">
            <div className="k-notice">
              <span>
                <strong>Deleted on {dayOnly(launch.deletedAt, timezone)}.</strong> It is hidden from the lists and nothing more of it goes out; the posts that were kept stay on their networks.
              </span>
            </div>
          </div>
        )}

        {drafting ? (
          <DraftingView jobs={jobs} />
        ) : failedView && launch.problem ? (
          <FailedCard
            problem={launch.problem}
            posted={launch.posts.length > 0}
            relaunch={!launch.ref.startsWith('article:') && launch.posts.length === 0 ? relaunch : null}
            busy={busy || running}
            detailsSearch={() => go({ tab: 'details' })}
          />
        ) : (
          <>
            {launch.problem && (
              <div className="k-px pub-notice">
                <div className="k-notice k-bad">
                  <span>
                    <strong>The launch failed.</strong> <span className="k-mono k-xs">{launch.problem}</span>
                  </span>
                </div>
              </div>
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
                      <a className="btn btn-small" href={reviewOk.pullRequest.url} target="_blank" rel="noreferrer">
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

            <LaunchTabs<TabId>
              value={tab}
              onValueChange={(next) => go({ tab: next })}
              tabs={[
                {
                  value: 'channels',
                  label: 'Channels',
                  panel: open ? (
                    <div className="k-px pub-legacy">
                      <Channels
                        launchId={launch.id}
                        repo={launch.repo}
                        rows={pieces.rows}
                        replies={pieces.replies}
                        drafts={reviewOk?.drafts ?? []}
                        capabilities={pieces.capabilities}
                        failures={launch.failures}
                        scheduling={{ ...pieces.scheduling, held: Boolean(app) }}
                        channel={search.channel}
                        onChannel={(channel) => go({ tab: 'channels', channel })}
                        numbers={numbers.channels}
                      />
                    </div>
                  ) : (
                    <>
                      {shown && <ViewsCard totals={numbers.totals} days={numbers.daily} waitingComments={data.waitingComments} />}
                      <ChannelList rows={pieces.rows} failures={launch.failures} scheduling={withScheduled(pieces.scheduling.channels, launch.posts)} replies={pieces.replies} numbers={numbers.channels} timezone={timezone} />
                      {data.fakeNetworks && (
                        <div className="k-px pub-notice">
                          <div className="k-notice k-wait">
                            <span>
                              <strong>A preview with fake networks.</strong> Edits, deletes and times change this copy of the data only: no request reaches a network, and nothing is written to GitHub.
                            </span>
                          </div>
                        </div>
                      )}
                    </>
                  ),
                },
                {
                  value: 'content',
                  label: 'Content',
                  panel: (
                    <div className="k-px pub-legacy">
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
                    </div>
                  ),
                },
                { value: 'search', label: 'Search', panel: <SearchPanel index={index} timezone={timezone} /> },
                {
                  value: 'details',
                  label: 'Details',
                  panel: (
                    <DetailsPanel
                      owner={owner}
                      timezone={timezone}
                      data={{
                        launch,
                        approval: app ? app.approval : undefined,
                        piecesOut: out,
                        repliesSent: Object.values(pieces.replies).reduce((a, b) => a + b, 0),
                        metrics: data.metrics,
                        accounts: pieces.accounts,
                        jobs,
                      }}
                    />
                  ),
                },
              ]}
            />
          </>
        )}
      </div>
    </LaunchActionsProvider>
  );
}

/** How a launch started, after "started 2 min ago" */
const STARTED_BY: Record<string, string> = {
  release: 'by the release',
  manual: 'by hand',
  public: 'when the repo went public',
  enabled: 'when launches were turned on',
  article: 'from Write',
};

/** The heading, inside the actions' provider so its ⋯ opens their sheet */
function Head({ name, version, pill, meta, menu }: { name: string; version: string | null; pill: { label: string; className: string }; meta: string; menu: boolean }) {
  const { openMenu } = useLaunchActions();
  return <LaunchHead name={name} version={version} pill={pill} meta={meta} {...(menu && { onMenu: openMenu })} />;
}
