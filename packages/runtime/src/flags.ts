/**
 * The switches of the refactor in docs/plans/performance-refactor.md: one per phase that changes
 * behaviour, off until it is turned on, so a phase ships dark, is turned on where it is verified and
 * is turned off again by an environment change and a restart, with no deploy. Set as a list:
 * `SHIPCAST_FLAGS=publishing-service,bullmq`.
 */
export const FLAGS = {
  /** Phase 2: every publish through PublishingService, with attempt rows and per-piece locks */
  'publishing-service': 'Publishing through PublishingService, with attempt rows and per-piece locks',
  /** Phase 5: secrets in the encrypted Postgres table instead of the file or the keychain */
  'secrets-table': 'Secrets in the encrypted secrets table',
  /** Phase 5: OAuth state, console links and the API limiter in Redis */
  'redis-state': 'Shared ephemeral state in Redis',
  /** Phase 6: BullMQ on redis-queue instead of pg-boss */
  bullmq: 'Jobs on BullMQ',
  /** Phase 7: pages read the drafts snapshot; GitHub is read on events and hourly */
  'github-events': 'GitHub read on events, pages from the drafts snapshot',
  /** Phase 8: metrics hourly and batched at each source's cadence; comments from notification feeds */
  'batched-metrics': 'Hourly, batched metrics and comment feeds',
  /** Phase 9: the pages update over SSE instead of polling */
  'realtime-ui': 'Pages updated over server-sent events',
} as const;

/**
 * Flags that were turned on in production and then became the only path, their switch removed. An
 * environment that still lists one (an old SHIPCAST_FLAGS) starts as before: the name is accepted and
 * ignored rather than refused as unknown, so retiring a flag never needs an environment change first.
 */
const RETIRED: ReadonlySet<string> = new Set([
  // The AI task runner is the only AI layer (docs/decisions/ai-layer.md)
  'ai-runner',
]);

export type Flag = keyof typeof FLAGS;

export class Flags {
  readonly #on: ReadonlySet<Flag>;

  constructor(on: Iterable<Flag> = []) {
    this.#on = new Set(on);
  }

  /** The flags of an environment; a name that is not a flag is reported rather than ignored */
  static fromEnv(env: NodeJS.ProcessEnv): Flags {
    const names = (env.SHIPCAST_FLAGS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((n) => n && !RETIRED.has(n));
    const unknown = names.filter((n) => !(n in FLAGS));
    if (unknown.length > 0) throw new Error(`SHIPCAST_FLAGS: unknown ${unknown.join(', ')}; known: ${Object.keys(FLAGS).join(', ')}`);
    return new Flags(names as Flag[]);
  }

  on(flag: Flag): boolean {
    return this.#on.has(flag);
  }

  /** Every flag and whether it is on, for the health answer and the logs */
  list(): Record<Flag, boolean> {
    return Object.fromEntries((Object.keys(FLAGS) as Flag[]).map((f) => [f, this.#on.has(f)])) as Record<Flag, boolean>;
  }
}
