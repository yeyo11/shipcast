import { articleUrls, failurePrefix, indexStatus, publishAgain as publishAgainIn, PublishRefused, readReview, reviewFromSnapshot, type DraftSnapshot, type Launch, type LaunchReadService, type Repositories, type Review, type ReviewGitHub } from '@shipcast/engine';
import type { Channel } from '@shipcast/schema';
import type { LaunchView, Tone } from './view';

/**
 * A launch stays `drafted` in the registry until its last piece is out, so its posts tell an approved
 * one (the blog live, or pieces scheduled) from one whose drafts still wait for the owner.
 */
export function stateOf(launch: Pick<Launch, 'status'>, failures: number, posts: ReadonlyArray<{ status: string }> = []): { label: string; tone: Tone } {
  switch (launch.status) {
    case 'detected':
    case 'generating':
      return { label: 'Drafting', tone: 'draft' };
    case 'drafted':
      if (failures > 0) return { label: 'Partly published', tone: 'failed' };
      if (posts.length === 0) return { label: 'Waiting for you', tone: 'waiting' };
      return posts.some((p) => p.status === 'live' || p.status === 'edited') ? { label: 'Going out', tone: 'published' } : { label: 'Scheduled', tone: 'published' };
    case 'published':
      return { label: 'Published', tone: 'published' };
    case 'skipped':
      return { label: 'Not launched', tone: 'quiet' };
    default:
      return { label: 'Failed', tone: 'failed' };
  }
}

/** The numbers worth a glance on a launch's card */
const HEADLINE: Array<[string, string, string]> = [
  ['blog', 'views', 'blog views'],
  ['github', 'stars', 'stars'],
  ['devto', 'views', 'dev.to views'],
  ['newsletter', 'clicks', 'newsletter clicks'],
];

export async function launchView(registry: Pick<Repositories, 'posts' | 'metrics' | 'comments' | 'cursors'>, launch: Launch): Promise<LaunchView> {
  const [cursors, metrics, posts, replies] = await Promise.all([
    registry.cursors.cursorsWithPrefix(failurePrefix(launch.id)),
    registry.metrics.latestMetrics(launch.id),
    registry.posts.posts(launch.id),
    registry.comments.sentReplies(launch.id),
  ]);
  const failures = cursors.map((c) => ({ channel: c.key.split(':')[2] ?? '', message: c.value }));
  const pullRequest = launch.detail?.match(/https:\/\/github\.com\/\S+\/pull\/\d+/)?.[0];
  return {
    id: launch.id,
    repo: launch.repo,
    ref: launch.ref,
    kind: launch.kind,
    trigger: launch.trigger,
    status: launch.status,
    state: stateOf(launch, failures.length, posts),
    pullRequest,
    problem: launch.status === 'failed' ? (launch.detail ?? undefined) : undefined,
    createdAt: launch.createdAt,
    posts: posts.map((p) => ({ id: p.id, channel: p.channel, kind: p.kind, url: p.url, publishedAt: p.publishedAt, status: p.status, scheduledAt: p.scheduledAt })),
    failures,
    replies,
    headline: HEADLINE.flatMap(([source, name, label]) => {
      const found = metrics.find((m) => m.source === source && m.name === name);
      return found ? [{ label, value: found.value }] : [];
    }),
    ...(launch.deletedAt && { deletedAt: launch.deletedAt }),
  };
}

/**
 * Everything a launch's page shows, and the REST API's launch: its pieces, the last reading of each
 * number, each search engine's view of each language's article, and its drafts as they are now.
 * Google is always listed, as the engine that matters most; Bing once it has been read at all.
 */
export async function launchDetail(
  registry: Pick<Repositories, 'posts' | 'metrics' | 'comments' | 'cursors'>,
  launch: Launch,
  deps: {
    github: ReviewGitHub;
    launchesRepo: string;
    /** With `github-events`: the drafts snapshot, read from the registry, instead of the pull request from GitHub */
    snapshot?: Promise<DraftSnapshot | undefined>;
    /** With `launch-store-read`: the drafts from the launch model's tables, for a launch they hold */
    stored?: Pick<LaunchReadService, 'review'> | undefined;
  },
) {
  const fromSnapshot = deps.snapshot?.then((s) => ({ review: s && reviewFromSnapshot(launch, s, deps.launchesRepo), readAt: s?.readAt ?? null }));
  const fromPullRequest = (): Promise<Review | undefined> => (fromSnapshot ? fromSnapshot.then((s) => s.review) : readReview(launch, deps));
  // The pull request is read from GitHub (or the snapshot, or the launch model), the rest from the registry: all at once
  const reviewing = (deps.stored ? deps.stored.review(launch, fromPullRequest) : fromPullRequest()).catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));
  const urls = articleUrls(await registry.posts.posts(launch.id, { channel: 'blog' }));
  const views = await Promise.all(
    urls.flatMap(({ lang, url }) =>
      (['google', 'bing'] as const).map(async (engine) => {
        const status = await indexStatus(registry, url, engine);
        return { engine, lang, url, indexed: status?.indexed ?? null, coverage: status?.coverage ?? null, checkedAt: status?.checkedAt ?? null };
      }),
    ),
  );
  const index = views.filter((v) => v.engine === 'google' || v.checkedAt !== null);
  const [review, latest, view] = await Promise.all([reviewing, registry.metrics.latestMetrics(launch.id), launchView(registry, launch)]);
  const metrics = latest.map((m) => ({ source: m.source, name: m.name, value: m.value, takenAt: m.takenAt, checkedAt: m.checkedAt }));
  // When the drafts were read from GitHub, for the page to say so; only with the snapshot
  const drafts = fromSnapshot && { draftsReadAt: (await fromSnapshot.catch(() => ({ readAt: null }))).readAt };
  return { launch: view, detail: launch.detail, review: review ?? null, metrics, index, ...drafts };
}

/**
 * Publishing again (the engine's publishAgain): a channel that failed for good gets another chance,
 * or a merged launch is followed; then its publishing is queued. A refusal is the answer's problem.
 */
export async function publishAgain(
  registry: Pick<Repositories, 'launches' | 'posts' | 'attempts' | 'metrics' | 'comments' | 'cursors'>,
  launchId: number,
  channel: Channel | undefined,
  startPublishing: (launch: Launch, retryChannel?: Channel) => Promise<string>,
): Promise<{ ok: true; job: string } | { ok: false; problem: string }> {
  let launch: Launch;
  try {
    launch = await publishAgainIn(registry, launchId, channel, registry.attempts);
  } catch (error) {
    if (error instanceof PublishRefused) return { ok: false, problem: error.message };
    throw error;
  }
  // The channel names the job ("Retrying devto for …"); the job forgets the failure again, harmlessly
  return { ok: true, job: await startPublishing(launch, channel) };
}
