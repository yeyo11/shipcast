import { articleUrls, editDraft, indexStatus, preflight, readReview } from '@shipcast/engine';
import { CHANNELS, type Channel } from '@shipcast/schema';
import { createServerFn } from '@tanstack/react-start';
import { appContext } from './context.server';
import { id, InvalidInput, list, object, text } from './input';
import { launchView } from './launches.server';
import { approve, startArticle, startLaunch, startPublishing } from './work.server';

const jobsView = async () =>
  (await appContext()).jobs
    .list()
    .map((j) => ({ id: j.id, title: j.title, state: j.state, log: j.log.slice(-8), link: j.link ?? null, startedAt: j.startedAt }));

export const listLaunches = createServerFn({ method: 'GET' }).handler(async () => {
  const { registry } = await appContext();
  const launches = await registry.recent(60);
  return { launches: await Promise.all(launches.map((l) => launchView(registry, l))), jobs: await jobsView() };
});

export const getLaunch = createServerFn({ method: 'GET' })
  .validator((input: unknown) => id(input))
  .handler(async ({ data }) => {
    const { registry, github, deps, brand } = await appContext();
    const launch = await registry.get(data);
    if (!launch) return null;
    const blog = (await registry.posts(launch.id)).find((p) => p.channel === 'blog');
    const site = blog?.url ? (await brand()).site : undefined;
    // Google's view of each language's article, as of the last metrics reading
    const index = blog?.url && site
      ? await Promise.all(
          articleUrls(blog.externalId, blog.url, site).map(async ({ lang, url }) => {
            const status = await indexStatus(registry, url);
            return { lang, url, indexed: status?.indexed ?? null, coverage: status?.coverage ?? null, checkedAt: status?.checkedAt ?? null };
          }),
        )
      : [];
    const review = await readReview(launch, { github, launchesRepo: deps.launchesRepo }).catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));
    const metrics = (await registry.latestMetrics(launch.id)).map((m) => ({ source: m.source, name: m.name, value: m.value, takenAt: m.takenAt }));
    return { launch: await launchView(registry, launch), detail: launch.detail, review: review ?? null, metrics, index, jobs: await jobsView() };
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
    const channel = o.channel === undefined ? undefined : text(o.channel, 'channel', 40);
    if (channel !== undefined && !(CHANNELS as readonly string[]).includes(channel)) throw new InvalidInput('unknown channel');
    return { id: id(o.id), channel: channel as Channel | undefined };
  })
  .handler(async ({ data }) => {
    const { registry } = await appContext();
    const launch = await registry.get(data.id);
    if (!launch) return { ok: false as const, problem: 'no such launch' };
    if (data.channel) {
      // Only this launch's failure is forgotten; the channel stays failed for any other launch
      await registry.deleteCursor(`publish-failed:${launch.id}:${data.channel}`);
      if (launch.status === 'published') await registry.setStatus(launch.id, 'drafted', launch.detail);
    } else if (launch.status !== 'drafted') {
      return { ok: false as const, problem: `the launch is ${launch.status}` };
    }
    return { ok: true as const, job: await startPublishing((await registry.get(launch.id))!) };
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
  .validator((input: unknown) => {
    const o = object(input, 'input');
    const repo = text(o.repo, 'repo', 140);
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new InvalidInput('a repo is owner/name');
    return { repo, ref: o.ref === undefined || o.ref === '' ? undefined : text(o.ref, 'ref', 140), direct: o.direct === true };
  })
  .handler(({ data }) => startLaunch(data.repo, data.ref, data.direct));

export const writeArticle = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const o = object(input, 'input');
    const lang = text(o.lang, 'lang', 2);
    if (lang !== 'en' && lang !== 'es') throw new InvalidInput('lang is en or es');
    const channels = list(o.channels, 'channels').filter((c): c is Channel => (CHANNELS as readonly string[]).includes(c));
    const title = text(o.title, 'title', 200).trim();
    const markdown = text(o.markdown, 'markdown', 200_000);
    if (!title || !markdown.trim()) throw new InvalidInput('an article needs a title and a body');
    return { input: { title, markdown, lang: lang as 'en' | 'es', channels }, direct: o.direct === true };
  })
  .handler(({ data }) => startArticle(data.input, data.direct));
