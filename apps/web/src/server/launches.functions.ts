import { imageUrl } from '@shipcast/schema';
import { preflight } from '@shipcast/engine';
import { createServerFn } from '@tanstack/react-start';
import { launchService } from './app-services';
import { appContext } from './context.server';
import { repoList } from './repo-list';
import { id, object, text } from './input';
import { ownerAvatarUrl } from './launch-list';
import { readLaunchesSearch } from './launches-search';
import { launchPage } from './launch-page.server';
import { launchNumbers, postAccounts, readTimezone } from './launch-summary.server';
import { fakeNetworks, PREVIEW_REFUSAL } from './preview.server';
import { launchView, publishAgain as publishAgainFor } from './launches.server';
import { articleRequest, channelName, launchRequest } from './requests';
import { approve, startArticle, startLaunch, startPublishing } from './work.server';

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
    const page = await launchPage({ registry, github, launchesRepo: deps.launchesRepo, ...(ctx.drafts && { drafts: ctx.drafts }) }, launch);
    return {
      ...page,
      /** A preview whose networks are fake says so, so nobody takes its "Deleted" for a real one */
      fakeNetworks: fakeNetworks(),
    };
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
    // A draft edit is a commit on the real pull request
    if (fakeNetworks()) return { ok: false as const, problem: PREVIEW_REFUSAL };
    try {
      await launches.editDraft(launch.id, data.path, data.content);
      return { ok: true as const };
    } catch (error) {
      return { ok: false as const, problem: error instanceof Error ? error.message : String(error) };
    }
  });

export const approveDrafts = createServerFn({ method: 'POST' })
  .validator((input: unknown) => id(input))
  .handler(({ data }) => approve(data));

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
  return { owner: b.github, repos: await repoList({ github: ctx.github, cache: ctx.flags.on('realtime-ui') ? ctx.process.shared.cache : undefined }, b.github) };
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
