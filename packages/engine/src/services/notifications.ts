import type { DraftResult } from '../pipeline.ts';
import type { PublishResult } from '../publish.ts';
import type { Launch } from '../registry.ts';

/** Where a line to the owner goes (their Telegram chat today); `@shipcast/connectors`' Telegram fits */
export interface Notifier {
  notify(text: string): Promise<unknown>;
}

const nameOf = (launch: Pick<Launch, 'repo' | 'ref'>) => `${launch.repo} ${launch.ref.replace(/^article:/, '')}`;

export interface PublishNoticeOptions {
  /**
   * Whether this run is the last one that will look at this launch on its own: the publish job's
   * last attempt, or a round (whose next run is a new round, not a retry of this one). Until then a
   * run that only found retryable failures stays quiet, because the next attempt may clear them.
   */
  final: boolean;
}

/**
 * What the owner is told after a publish run, or nothing. The one rule for every path that
 * publishes (the publish job, a round, the CLI), where the job and the round each had their own:
 * - nothing for a run still waiting for the site, or a launch whose drafts were closed;
 * - nothing when the run brought no news: nothing posted, no problem, and the launch not finished;
 * - nothing while only retryable failures happened, nothing went out and another attempt follows;
 * - otherwise one line: the posts' addresses when it is all out, the problems when something
 *   failed, what is still scheduled when only time is missing.
 */
export function publishNotice(launch: Pick<Launch, 'repo' | 'ref'>, result: PublishResult, options: PublishNoticeOptions): string | undefined {
  if (result.state === 'waiting' || result.state === 'skipped') return undefined;
  const news = result.posted.length > 0 || result.problems.length > 0 || result.state === 'published';
  if (!news) return undefined;
  const willRetry = result.state === 'partial' && result.failures.some((f) => f.retryable);
  if (willRetry && result.posted.length === 0 && !options.final) return undefined;
  const name = nameOf(launch);
  const urls = result.posted.map((p) => p.url).join(' ');
  if (result.problems.length > 0) return `Shipcast published ${name} in part: ${result.problems.join('; ')}`;
  if (result.state === 'published') return `Shipcast published ${name}: ${urls || 'nothing new'}`;
  return `Shipcast published ${name}: ${urls || 'nothing yet'}; scheduled: ${result.scheduled.map((p) => `${p.channel} at ${p.at}`).join(', ')}`;
}

/** What the owner is told after a launch or an article was drafted: where to review it, or why it could not be */
export function draftNotice(launch: Pick<Launch, 'repo' | 'ref'>, result: DraftResult, options: { article?: string } = {}): string {
  const what = options.article === undefined ? nameOf(launch) : `the article “${options.article}”`;
  return result.ok ? `Shipcast drafted ${what}: review the drafts at ${result.pullRequest}` : `Shipcast could not draft ${what}: ${result.problems[0] ?? ''}`;
}

/**
 * The lines Shipcast sends the owner. A notice that fails to go out never fails the work it tells
 * of: the launch is published whether or not Telegram answered.
 */
export class NotificationService {
  readonly #notifier: Notifier | undefined;

  constructor(notifier: Notifier | undefined) {
    this.#notifier = notifier;
  }

  /** Sends a line as it is */
  async say(text: string): Promise<void> {
    await this.#notifier?.notify(text).catch(() => undefined);
  }

  /** Tells what a publish run did, by publishNotice's rule; answers the line sent, if any */
  async published(launch: Pick<Launch, 'repo' | 'ref'>, result: PublishResult, options: PublishNoticeOptions): Promise<string | undefined> {
    const notice = publishNotice(launch, result, options);
    if (notice) await this.say(notice);
    return notice;
  }

  /** Tells where a launch's (or an article's) drafts wait, or why there are none */
  async drafted(launch: Pick<Launch, 'repo' | 'ref'>, result: DraftResult, options: { article?: string } = {}): Promise<void> {
    await this.say(draftNotice(launch, result, options));
  }
}
