import type { Brand, Channel } from '@shipcast/schema';
import type { GitHubSource } from '../github.ts';
import { approval, publishLaunch, type PublishDeps, type PublishResult } from '../publish.ts';
import type { Launch, Repositories } from '../repositories/index.ts';
import type { PublishAttempts } from './attempts.ts';
import { PieceGuard } from './guard.ts';
import { publishAgain, retryChannel } from './retry.ts';

/** What the networks are reached with for one run: the brand's connectors, built by the caller */
export type PublishConnectors = Pick<PublishDeps, 'publishers' | 'strategies' | 'channels' | 'search' | 'accounts' | 'fetch' | 'now'>;

/**
 * Publishing a launch, the one way every entry point does it (docs/plans/performance-refactor.md,
 * phase 2): the publish job, a scheduled piece's wake-up, a round and the CLI. Each run holds a claim
 * on every channel it sends (`publish_attempts`), so two runs of the same launch at once send each
 * piece once, and a run cut short is never repeated where the network could post twice.
 */
export class PublishingService {
  readonly #registry: Pick<Repositories, 'launches' | 'posts' | 'attempts' | 'cursors'>;
  readonly #github: GitHubSource;
  readonly #launchesRepo: string;
  readonly #attempts: PublishAttempts;
  readonly #launchStore: PublishDeps['launchStore'];

  constructor(deps: { registry: Pick<Repositories, 'launches' | 'posts' | 'attempts' | 'cursors'>; github: GitHubSource; launchesRepo: string; attempts?: PublishAttempts; launchStore?: PublishDeps['launchStore'] }) {
    this.#registry = deps.registry;
    this.#github = deps.github;
    this.#launchesRepo = deps.launchesRepo;
    this.#attempts = deps.attempts ?? deps.registry.attempts;
    this.#launchStore = deps.launchStore;
  }

  get attempts(): PublishAttempts {
    return this.#attempts;
  }

  /** Whether the launch's drafts are approved (merged, or published straight), without publishing anything */
  approval(launch: Launch) {
    return approval(launch, { github: this.#github, launchesRepo: this.#launchesRepo });
  }

  /** One run of a launch's publishing by `holder` (a job's id): what is due goes out, once */
  publish(launch: Launch, brand: Brand, connectors: PublishConnectors, holder: string): Promise<PublishResult> {
    return publishLaunch(launch, brand, {
      ...connectors,
      registry: this.#registry,
      github: this.#github,
      launchesRepo: this.#launchesRepo,
      guard: new PieceGuard(this.#attempts, holder),
      keepUnpublishable: true,
      ...(this.#launchStore && { launchStore: this.#launchStore }),
    });
  }

  /** The owner's Try again on a channel of a launch */
  retry(launchId: number, channel: Channel): Promise<Launch | undefined> {
    return retryChannel(this.#registry, launchId, channel, this.#attempts);
  }

  /** Publishing again from the app or the API: a channel's Try again, or following a drafted launch (publishAgain) */
  again(launchId: number, channel: Channel | undefined): Promise<Launch> {
    return publishAgain(this.#registry, launchId, channel, this.#attempts);
  }
}
