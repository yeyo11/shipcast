import { editDraft, preflight } from '@shipcast/engine';
import { createServerFn } from '@tanstack/react-start';
import { appContext } from './context.server';
import { id, object, text } from './input';
import { jobsView } from './jobs.server';
import { launchNumbers, postAccounts, readTimezone, waitingComments } from './launch-summary.server';
import { launchPieces } from './pieces.server';
import { fakeNetworks, PREVIEW_REFUSAL } from './preview.server';
import { launchDetail, launchView, publishAgain as publishAgainFor } from './launches.server';
import { articleRequest, channelName, launchRequest } from './requests';
import { approve, startArticle, startLaunch, startPublishing } from './work.server';

export const listLaunches = createServerFn({ method: 'GET' }).handler(async () => {
  const { registry } = await appContext();
  const launches = await registry.recent(60);
  const [views, numbers, accounts, timezone] = await Promise.all([
    Promise.all(launches.map((l) => launchView(registry, l))),
    launchNumbers(registry, launches),
    postAccounts(registry, launches),
    readTimezone(registry),
  ]);
  // The queue's jobs are Automation's now: the list is launches only
  return { launches: views.map((v) => ({ ...v, numbers: numbers.get(v.id) ?? null, postAccounts: accounts.get(v.id) ?? {} })), timezone };
});

export const getLaunch = createServerFn({ method: 'GET' })
  .validator((input: unknown) => id(input))
  .handler(async ({ data }) => {
    const { registry, github, deps } = await appContext();
    const launch = await registry.get(data);
    if (!launch) return null;
    const detail = await launchDetail(registry, launch, { github, launchesRepo: deps.launchesRepo });
    const draftPaths = detail.review && !('error' in detail.review) ? detail.review.drafts.map((d) => d.path) : [];
    return {
      ...detail,
      pieces: await launchPieces(registry, launch, { github, launchesRepo: deps.launchesRepo, draftPaths }),
      jobs: await jobsView(registry, { launchId: launch.id }),
      numbers: (await launchNumbers(registry, [launch])).get(launch.id)!,
      waitingComments: await waitingComments(registry, launch.id),
      /** A preview whose networks are fake says so, so nobody takes its "Deleted" for a real one */
      fakeNetworks: fakeNetworks(),
    };
  });

export const saveDraft = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const o = object(input, 'input');
    return { id: id(o.id), path: text(o.path, 'path', 300), content: text(o.content, 'content', 200_000) };
  })
  .handler(async ({ data }) => {
    const { registry, github, deps } = await appContext();
    const launch = await registry.get(data.id);
    if (!launch) return { ok: false as const, problem: 'no such launch' };
    // A draft edit is a commit on the real pull request
    if (fakeNetworks()) return { ok: false as const, problem: PREVIEW_REFUSAL };
    try {
      await editDraft(launch, data.path, data.content, { github, launchesRepo: deps.launchesRepo });
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
  .handler(async ({ data }) => {
    const { registry } = await appContext();
    const launch = await registry.get(data.id);
    if (!launch) return { ok: false as const, problem: 'no such launch' };
    return publishAgainFor(registry, launch, data.channel, startPublishing);
  });

export const listRepos = createServerFn({ method: 'GET' }).handler(async () => {
  const { github, brand } = await appContext();
  const b = await brand();
  return { owner: b.github, repos: await github.userRepos(b.github) };
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
