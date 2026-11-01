import { createFileRoute, getRouteApi, notFound, useRouter } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { LaunchContentPanel } from '../../../components/approve/ContentPanel';
import { LaunchApproval } from '../../../components/approve/LaunchApproval';
import { Icon } from '../../../components/kit/Icon';
import { useLiveEnabled, useLiveRoute } from '../../../components/live/Live';
import { ChannelList, ViewsCard } from '../../../components/launch/ChannelList';
import { ago, dayOnly } from '../../../components/launch/dates';
import { LaunchActionsProvider, useLaunchActions } from '../../../components/launch/LaunchActions';
import { LaunchHead, LaunchTabs } from '../../../components/launch/LaunchHead';
import { DetailsPanel, DraftingView, FailedCard, SearchPanel, useNow } from '../../../components/launch/LaunchPanels';
import { pillClass, withScheduled } from '../../../components/launch/published';
import { useToast } from '../../../components/Toasts';
import { getLaunch, launchRepo } from '../../../server/launches.functions';
import { canRelaunch } from '../../../server/launch-list';

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


function LaunchPage() {
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const { launch, review, index, jobs, pieces, numbers } = data;
  const running = jobs.some((j) => j.state === 'running' && !j.queued) || launch.status === 'generating';
  // Live: this launch's own events reload it, whether or not something runs
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

  // Waiting for the owner (section approve): its own view (boards LaunchReview, LaunchContent and
  // DesktopLaunchReview, whose desktop is a wider page with the approval beside the tabs), inside the
  // launch's actions so its ⋯ is the launch menu; Search engines and Details are the page's own panels
  const waiting = launch.status === 'drafted' && open && !launch.deletedAt;
  const details = (
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
  );

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
      deletable={!launch.deletedAt}
      pending={launch.status === 'drafted' && !open}
      waiting={waiting}
      running={running}
      relaunch={canRelaunch(launch) ? { run: relaunch, busy: busy || running } : null}
      problem={launch.problem ?? null}
      failed={launch.status === 'failed'}
      onDeleted={async () => {
        await router.invalidate();
        await router.navigate({ to: '/' });
      }}
    >
      {waiting ? (
        <LaunchApproval
          data={data}
          tab={tab}
          onTab={(next) => go({ tab: next })}
          channel={search.channel}
          onChannel={(channel) => go({ tab: 'channels', channel })}
          search={<SearchPanel index={index} timezone={timezone} />}
          details={details}
          menu={<MenuButton />}
        />
      ) : (
      <div className="pub-page">
        <Head name={shortName} version={version} pill={{ label: launch.state.label, className: pillClass(launch.state.tone, launch.status) }} meta={meta} menu={!drafting} primary={!failedView} />

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
            relaunch={canRelaunch(launch) ? relaunch : null}
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
            <LaunchTabs<TabId>
              value={tab}
              onValueChange={(next) => go({ tab: next })}
              tabs={[
                {
                  value: 'channels',
                  label: 'Channels',
                  panel: (
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
                  panel: <LaunchContentPanel data={data} running={running} />,
                },
                { value: 'search', label: 'Search', panel: <SearchPanel index={index} timezone={timezone} /> },
                {
                  value: 'details',
                  label: 'Details',
                  panel: details,
                },
              ]}
            />
          </>
        )}
      </div>
      )}
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

/** The waiting view's ⋯: the launch menu of the actions' provider; none when it would be empty */
function MenuButton() {
  const { openMenu, menu } = useLaunchActions();
  if (menu.length === 0) return null;
  return (
    <button type="button" className="k-btn k-icon" aria-label="More actions" aria-haspopup="menu" onClick={(event) => openMenu(event.currentTarget)}>
      <Icon name="more" />
    </button>
  );
}

/**
 * The heading, inside the actions' provider so its ⋯ opens their menu. A failed release shows
 * "Launch it again" beside the ⋯ on a desktop (board DesktopLaunchMenu), unless the failed card
 * already offers it (`primary` false)
 */
function Head({ name, version, pill, meta, menu, primary }: { name: string; version: string | null; pill: { label: string; className: string }; meta: string; menu: boolean; primary: boolean }) {
  const { openMenu, menu: entries, relaunch } = useLaunchActions();
  const again =
    primary && relaunch ? (
      <span className="k-desktop">
        <button type="button" className="k-btn k-pri" disabled={relaunch.busy} onClick={() => void relaunch.run()}>
          <Icon name="retry" size={18} />
          {relaunch.busy ? 'Launching…' : 'Launch it again'}
        </button>
      </span>
    ) : undefined;
  return <LaunchHead name={name} version={version} pill={pill} meta={meta} primary={again} {...(menu && entries.length > 0 && { onMenu: openMenu })} />;
}
