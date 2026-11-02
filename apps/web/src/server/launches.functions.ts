import { imageUrl } from '@shipcast/schema';
import { isAppLaunch, type Launch } from '@shipcast/engine';
import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { launchService } from './app-services';
import { appContext } from './context.server';
import { deletionService } from './deletion.server';
import { draftsApi } from './drafts.server';
import { channelList } from './post-changes';
import { reposApi } from './repos.server';
import { id, object, text } from './input';
import { draftingNote, ownerAvatarUrl, readyPieces } from './launch-list';
import { readLaunchesSearch } from './launches-search';
import { cookieOf, readSession, SESSION_COOKIE } from './session.server';
import { launchPage } from './launch-page.server';
import { launchNumbers, postAccounts, readTimezone } from './launch-summary.server';
import { fakeNetworks } from './preview.server';
import { launchView, publishAgain as publishAgainFor } from './launches.server';
import { CHANNEL_NAMES } from './view';
import { approvalRequest, articleRequest, channelName, launchRequest, sourcesRequest } from './requests';
import { approve, startArticle, startLaunch, startPublishing, startSources } from './work.server';

/** A page holds a few rows of cards on any screen, two or three across, and each card reads its own numbers */
const LAUNCHES_PAGE = 24;

/**
 * What the Launches page says of a launch beyond its view: when it last changed, whether Shipcast
 * holds its drafts (no pull request to point at) and which pieces are ready, and what a launch being
 * drafted is doing now. A few rows per launch, and only for the launches that need them.
 */
async function listGlance(registry: Awaited<ReturnType<typeof appContext>>['registry'], launch: Launch) {
  const waiting = launch.status === 'drafted';
  const drafting = launch.status === 'detected' || launch.status === 'generating';
  const [drafts, jobs] = await Promise.all([
    waiting ? registry.launchStore.drafts(launch.id) : Promise.resolve([]),
    drafting ? registry.jobs.jobs({ launchId: launch.id, listed: true, limit: 1 }) : Promise.resolve([]),
  ]);
  const held = isAppLaunch(launch) || drafts.length > 0;
  return {
    updatedAt: launch.updatedAt,
    held,
    ready: drafts.length > 0 ? readyPieces(drafts.map((d) => d.channel), (c) => CHANNEL_NAMES[c] ?? c) : null,
    drafting: drafting ? draftingNote(jobs[0]?.log ?? []) : null,
  };
}

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
    // Each launch's view carries the title the launch model keeps (read with the page's own rows), so
    // an article is named by it here as on its page
    const [views, numbers, accounts, timezone, glance] = await Promise.all([
      Promise.all(launches.map((l) => launchView(registry, l))),
      launchNumbers(registry, launches),
      postAccounts(registry, launches),
      readTimezone(registry),
      Promise.all(launches.map((l) => listGlance(registry, l))),
    ]);
    // The queue's jobs are Automation's now: the list is launches only
    return {
      launches: views.map((v, i) => ({
        ...v,
        ...glance[i]!,
        numbers: numbers.get(v.id) ?? null,
        postAccounts: accounts.get(v.id) ?? {},
        avatarUrl: imageUrl(ownerAvatarUrl(v.repo)) ?? null,
      })),
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
    const page = await launchPage({ registry, github, launchesRepo: deps.launchesRepo, stored: ctx.launchRead }, launch);
    return {
      ...page,
      /** A preview whose networks are fake says so, so nobody takes its "Deleted" for a real one */
      fakeNetworks: fakeNetworks(),
    };
  });

/** What deleting a launch would do, for the owner to choose before anything happens (docs/launch-delete.md) */
export const getDeletion = createServerFn({ method: 'GET' })
  .validator((input: unknown) => id(input))
  .handler(async ({ data }) => {
    const service = deletionService(await appContext());
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

export const saveDraft = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const o = object(input, 'input');
    return { id: id(o.id), path: text(o.path, 'path', 300), content: text(o.content, 'content', 200_000) };
  })
  .handler(async ({ data }) => asProblem(async () => draftsApi(await appContext()).edit(data.id, data.path, data.content, await signedIn())));

/**
 * "Preview on the real site" (docs/app-review.md): the article and its media pushed to a preview
 * branch of the launches repo, whose draft pull request the site's workflow deploys in a few minutes
 */
export const previewOnSite = createServerFn({ method: 'POST' })
  .validator((input: unknown) => id(input))
  .handler(async ({ data }) => asProblem(async () => draftsApi(await appContext()).requestPreview(data)));

/** Looks for the preview's address, which the site's workflow writes on its pull request once deployed */
export const findSitePreview = createServerFn({ method: 'POST' })
  .validator((input: unknown) => id(input))
  .handler(async ({ data }) => asProblem(async () => draftsApi(await appContext()).findPreview(data)));

/** A drafts action's answer to the page: what went wrong in words, rather than a thrown error, as its refusals are */
async function asProblem<T>(run: () => Promise<T>): Promise<T | { ok: false; problem: string }> {
  try {
    return await run();
  } catch (error) {
    return { ok: false as const, problem: error instanceof Error ? error.message : String(error) };
  }
}

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

export const listRepos = createServerFn({ method: 'GET' }).handler(async () => reposApi(await appContext()).repos());

/** Each release with the launch already made of it, the same answer GET /repos/releases gives */
export const listReleases = createServerFn({ method: 'GET' })
  .validator((input: unknown) => text(input, 'repo', 140))
  .handler(async ({ data }) => reposApi(await appContext()).releases(data));

export const checkRepo = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const o = object(input, 'input');
    return { repo: text(o.repo, 'repo', 140), ref: o.ref === undefined || o.ref === '' ? undefined : text(o.ref, 'ref', 140) };
  })
  .handler(async ({ data }) => reposApi(await appContext()).check(data.repo, data.ref));

export const launchRepo = createServerFn({ method: 'POST' })
  .validator((input: unknown) => launchRequest(input))
  .handler(({ data }) => startLaunch(data.repo, data.ref, data.direct));

export const writeArticle = createServerFn({ method: 'POST' })
  .validator((input: unknown) => articleRequest(input))
  .handler(({ data }) => startArticle(data.input, data.direct));

/** A launch made from sources, drafted as a job */
export const launchFromSources = createServerFn({ method: 'POST' })
  .validator((input: unknown) => sourcesRequest(input))
  .handler(({ data }) => startSources(data));

// An image for a launch made from sources is uploaded through POST /api/sources/media (routes/api/sources/media.ts), not a server function
