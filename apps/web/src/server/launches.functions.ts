import { imageUrl } from '@shipcast/schema';
import { isAppLaunch, preflight, type Launch } from '@shipcast/engine';
import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { launchService } from './app-services';
import { appContext } from './context.server';
import { deletionService } from './deletion.server';
import { channelList } from './post-changes';
import { repoList } from './repo-list';
import { id, InvalidInput, object, text } from './input';
import { ownerAvatarUrl } from './launch-list';
import { readLaunchesSearch } from './launches-search';
import { cookieOf, readSession, SESSION_COOKIE } from './session.server';
import { launchPage } from './launch-page.server';
import { launchNumbers, postAccounts, readTimezone } from './launch-summary.server';
import { fakeNetworks, PREVIEW_REFUSAL } from './preview.server';
import { launchView, publishAgain as publishAgainFor } from './launches.server';
import { approvalRequest, articleRequest, channelName, launchRequest, sourcesRequest } from './requests';
import { approve, startArticle, startLaunch, startPublishing, startSources, uploadSource } from './work.server';

/** A page holds a few rows of cards on any screen, two or three across, and each card reads its own numbers */
const LAUNCHES_PAGE = 24;

/** One page of launches for the filters in the address, with what the filters can offer: a handful of queries whatever the list's size */
export const listLaunches = createServerFn({ method: 'GET' })
  .validator((input: unknown) => readLaunchesSearch(object(input ?? {}, 'input')))
  .handler(async ({ data }) => {
    const ctx = await appContext();
    const { registry } = ctx;
    const { page, facets } = await launchService(ctx).page({
      pageSize: LAUNCHES_PAGE,
      ...(data.q && { search: data.q }),
      ...(data.status && { status: data.status }),
      ...(data.trigger && { trigger: data.trigger }),
      ...(data.kind && { kind: data.kind }),
      ...(data.repo && { repo: data.repo }),
      ...(data.sort && { order: data.sort }),
      ...(data.page && { page: data.page }),
    });
    const launches = page.launches;
    const [views, numbers, accounts, timezone] = await Promise.all([
      Promise.all(launches.map((l) => launchView(registry, l))),
      launchNumbers(registry, launches),
      postAccounts(registry, launches),
      readTimezone(registry),
    ]);
    // The queue's jobs are Automation's now: the list is launches only
    return {
      launches: views.map((v) => ({ ...v, numbers: numbers.get(v.id) ?? null, postAccounts: accounts.get(v.id) ?? {}, avatarUrl: imageUrl(ownerAvatarUrl(v.repo)) ?? null })),
      page: { number: page.page, pages: page.pages, total: page.total, size: page.pageSize },
      facets,
      timezone,
    };
  });

export const getLaunch = createServerFn({ method: 'GET' })
  .validator((input: unknown) => id(input))
  .handler(async ({ data }) => {
    const ctx = await appContext();
    const { registry, github, deps } = ctx;
    const launch = await launchService(ctx).get(data);
    if (!launch) return null;
    const page = await launchPage({ registry, github, launchesRepo: deps.launchesRepo, ...(ctx.drafts && { drafts: ctx.drafts }), stored: ctx.launchRead }, launch);
    return {
      ...page,
      /** A preview whose networks are fake says so, so nobody takes its "Deleted" for a real one */
      fakeNetworks: fakeNetworks(),
      /** With `launch-delete`: the page offers to delete the launch (docs/launch-delete.md) */
      deletable: ctx.flags.on('launch-delete'),
    };
  });

const DELETE_OFF = 'launches are deleted only with the launch-delete flag on';

/** What deleting a launch would do, for the owner to choose before anything happens (docs/launch-delete.md) */
export const getDeletion = createServerFn({ method: 'GET' })
  .validator((input: unknown) => id(input))
  .handler(async ({ data }) => {
    const service = deletionService(await appContext());
    if (!service) return { ok: false as const, problem: DELETE_OFF };
    try {
      const { mode, refused, channels, articleLinks } = await service.plan(data);
      return { ok: true as const, plan: { mode, refused: refused ?? null, channels, articleLinks } };
    } catch (error) {
      return { ok: false as const, problem: error instanceof Error ? error.message : String(error) };
    }
  });

/** Deletes a launch: removed when it never published, otherwise hidden, with the posts of the channels ticked deleted on their networks */
export const deleteLaunch = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const o = object(input, 'input');
    return { id: id(o.id), channels: channelList(o.channels) ?? [] };
  })
  .handler(async ({ data }) => {
    const service = deletionService(await appContext());
    if (!service) return { ok: false as const, problem: DELETE_OFF };
    try {
      const result = await service.delete(data.id, { channels: data.channels, by: (await signedIn()) ?? 'owner' });
      return {
        ok: true as const,
        mode: result.mode,
        warning: result.warning ?? null,
        problems: result.problems,
        failed: result.outcomes.flatMap((o) => (o.ok ? [] : [`${o.channel || 'a post'}: ${o.problem}`])),
        deleted: result.outcomes.filter((o) => o.ok).length,
      };
    } catch (error) {
      return { ok: false as const, problem: error instanceof Error ? error.message : String(error) };
    }
  });

/**
 * "Refresh from GitHub": the drafts pull request read again and its snapshot rewritten, for when the
 * owner knows GitHub changed and the delivery has not arrived. Only with `github-events`, where the
 * page reads the snapshot; without it every view already reads GitHub.
 */
export const refreshDrafts = createServerFn({ method: 'POST' })
  .validator((input: unknown) => id(input))
  .handler(async ({ data }) => {
    const ctx = await appContext();
    if (!ctx.drafts) return { ok: false as const, problem: 'the drafts are read from GitHub on every view already' };
    const launch = await launchService(ctx).get(data);
    if (!launch) return { ok: false as const, problem: 'no such launch' };
    try {
      const snapshot = await ctx.drafts.refresh(launch);
      return snapshot ? { ok: true as const, readAt: snapshot.readAt } : { ok: false as const, problem: 'this launch has no drafts pull request' };
    } catch (error) {
      return { ok: false as const, problem: error instanceof Error ? error.message : String(error) };
    }
  });

export const saveDraft = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const o = object(input, 'input');
    return { id: id(o.id), path: text(o.path, 'path', 300), content: text(o.content, 'content', 200_000) };
  })
  .handler(async ({ data }) => {
    const launches = launchService(await appContext());
    const launch = await launches.get(data.id);
    if (!launch) return { ok: false as const, problem: 'no such launch' };
    // A draft edit is a commit on the real pull request; a launch Shipcast holds keeps it in its own rows
    if (fakeNetworks() && !isAppLaunch(launch)) return { ok: false as const, problem: PREVIEW_REFUSAL };
    try {
      await launches.editDraft(launch.id, data.path, data.content, await signedIn());
      return { ok: true as const };
    } catch (error) {
      return { ok: false as const, problem: error instanceof Error ? error.message : String(error) };
    }
  });

/** A launch Shipcast holds, for its preview on the real site; a refusal when it is not one or the flag is off */
async function heldLaunch(launchId: number): Promise<{ ok: true; launch: Launch; service: NonNullable<Awaited<ReturnType<typeof appContext>>['appReview']> } | { ok: false; problem: string }> {
  const ctx = await appContext();
  if (!ctx.appReview) return { ok: false, problem: 'launches are reviewed in Shipcast only with the app-review flag on' };
  const launch = await launchService(ctx).get(launchId);
  if (!launch) return { ok: false, problem: 'no such launch' };
  if (!isAppLaunch(launch)) return { ok: false, problem: 'this launch is reviewed in its pull request, which has its own preview' };
  return { ok: true, launch, service: ctx.appReview };
}

/**
 * "Preview on the real site" (docs/app-review.md): the article and its media pushed to a preview
 * branch of the launches repo, whose draft pull request the site's workflow deploys in a few minutes
 */
export const previewOnSite = createServerFn({ method: 'POST' })
  .validator((input: unknown) => id(input))
  .handler(async ({ data }) => {
    // It writes a branch and a pull request on the real launches repo
    if (fakeNetworks()) return { ok: false as const, problem: PREVIEW_REFUSAL };
    const held = await heldLaunch(data);
    if (!held.ok) return held;
    try {
      return { ok: true as const, preview: await held.service.requestPreview(held.launch) };
    } catch (error) {
      return { ok: false as const, problem: error instanceof Error ? error.message : String(error) };
    }
  });

/** Looks for the preview's address, which the site's workflow writes on its pull request once deployed */
export const findSitePreview = createServerFn({ method: 'POST' })
  .validator((input: unknown) => id(input))
  .handler(async ({ data }) => {
    const held = await heldLaunch(data);
    if (!held.ok) return held;
    try {
      const preview = await held.service.findPreview(held.launch);
      return preview ? { ok: true as const, preview } : { ok: false as const, problem: 'no preview was asked for' };
    } catch (error) {
      return { ok: false as const, problem: error instanceof Error ? error.message : String(error) };
    }
  });

/** The signed-in login, which a launch Shipcast holds records on an edit or an approval */
async function signedIn(): Promise<string | null> {
  const session = await readSession((await appContext()).secrets, cookieOf(getRequest(), SESSION_COOKIE));
  return session?.login ?? null;
}

export const approveDrafts = createServerFn({ method: 'POST' })
  .validator((input: unknown) => approvalRequest(input))
  .handler(async ({ data }) => approve(data.id, (await signedIn()) ?? undefined, data.versions));

/** Publishing again: a channel that failed for good gets another chance, or a merged launch is followed */
export const publishAgain = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const o = object(input, 'input');
    return { id: id(o.id), channel: o.channel === undefined ? undefined : channelName(o.channel) };
  })
  .handler(async ({ data }) => publishAgainFor((await appContext()).registry, data.id, data.channel, startPublishing));

export const listRepos = createServerFn({ method: 'GET' }).handler(async () => {
  const ctx = await appContext();
  const b = await ctx.brand();
  return {
    owner: b.github,
    repos: await repoList({ github: ctx.github, cache: ctx.flags.on('realtime-ui') ? ctx.process.shared.cache : undefined }, b.github),
    // Whether a launch can also be made from sources here (launch-sources)
    sources: ctx.flags.on('launch-sources'),
    // Whether new drafts wait in Shipcast rather than in a pull request (app-review)
    appReview: ctx.flags.on('app-review'),
  };
});

export const listReleases = createServerFn({ method: 'GET' })
  .validator((input: unknown) => text(input, 'repo', 140))
  .handler(async ({ data }) => (await appContext()).github.releases(data));

export const checkRepo = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const o = object(input, 'input');
    return { repo: text(o.repo, 'repo', 140), ref: o.ref === undefined || o.ref === '' ? undefined : text(o.ref, 'ref', 140) };
  })
  .handler(async ({ data }) => preflight(data.repo, data.ref, { github: (await appContext()).github }));

export const launchRepo = createServerFn({ method: 'POST' })
  .validator((input: unknown) => launchRequest(input))
  .handler(({ data }) => startLaunch(data.repo, data.ref, data.direct));

export const writeArticle = createServerFn({ method: 'POST' })
  .validator((input: unknown) => articleRequest(input))
  .handler(({ data }) => startArticle(data.input, data.direct));

/** A launch made from sources (launch-sources), drafted as a job */
export const launchFromSources = createServerFn({ method: 'POST' })
  .validator((input: unknown) => sourcesRequest(input))
  .handler(({ data }) => startSources(data));

/** An image for a launch made from sources, into the media store; the page names it by the sha256 answered */
export const uploadSourceFile = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const file = input instanceof FormData ? input.get('file') : null;
    if (!(file instanceof Blob)) throw new InvalidInput('send the file as `file` in a form');
    return file;
  })
  .handler(async ({ data }) => {
    const answer = await uploadSource(new Uint8Array(await data.arrayBuffer()));
    if (!answer.ok) return answer;
    const { sha256, mime, width, height } = answer.file;
    return { ok: true as const, file: { sha256, mime, width, height } };
  });
