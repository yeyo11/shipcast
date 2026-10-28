import type { Channel, LaunchConfig } from '@shipcast/schema';
import type { ScheduleStore } from '../ports.ts';
import { recommendFor, type Recommendation } from '../recommend.ts';
import type { Launch, Post } from '../registry.ts';
import { cancelScheduledPost, readTimezone, reschedulePost, saveTimezone, scheduleLaunch, ScheduleRefused } from '../schedule.ts';

/** The best times' history and audience: the stats queries recommendFor runs */
export type RecommendSource = Parameters<typeof recommendFor>[0];

export interface ScheduleServiceDeps {
  store: ScheduleStore;
  recommendations: RecommendSource;
  /** The launch's launch.yml, when it can be read, so a channel it sets to off is refused */
  launchConfig(launch: Launch): Promise<LaunchConfig | undefined>;
  /** Queues (or moves) the wake-up of each scheduled piece at its time */
  arm(posts: Post[]): Promise<void>;
}

/**
 * When each piece of a launch goes out (docs/scheduling.md): setting, moving and cancelling a time,
 * the recommended times and the owner's time zone. The launch page and the REST API both come here,
 * so a schedule is always checked against launch.yml and always armed in the queue.
 */
export class ScheduleService {
  readonly #deps: ScheduleServiceDeps;

  constructor(deps: ScheduleServiceDeps) {
    this.#deps = deps;
  }

  /** Sets the time of each channel named; a channel scheduled already is moved */
  async schedule(launchId: number, times: Partial<Record<Channel, Date>>): Promise<Post[]> {
    const launch = await this.#deps.store.get(launchId);
    if (!launch) throw new ScheduleRefused('not_found', 'no such launch');
    // Best effort: a launch.yml that cannot be read yet (an article's, before its merge) leaves the check to the publish step
    const config = await this.#deps.launchConfig(launch).catch(() => undefined);
    const posts = await scheduleLaunch(this.#deps.store, launchId, times, config ? { config } : {});
    await this.#deps.arm(posts);
    return posts;
  }

  /** Moves a scheduled piece; now, or a time past, sends it on the next run */
  async move(postId: number, at: Date): Promise<Post> {
    const post = await reschedulePost(this.#deps.store, postId, at);
    await this.#deps.arm([post]);
    return post;
  }

  /** Cancels a scheduled piece: its channel is not published for that launch until scheduled again */
  cancel(postId: number): Promise<Post> {
    return cancelScheduledPost(this.#deps.store, postId);
  }

  recommend(channel: Channel, options: { days?: number; count?: number } = {}): Promise<Recommendation> {
    return recommendFor(this.#deps.recommendations, channel, options);
  }

  timezone(): Promise<string> {
    return readTimezone(this.#deps.store);
  }

  setTimezone(name: unknown): Promise<string> {
    return saveTimezone(this.#deps.store, name);
  }
}
