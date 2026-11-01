/**
 * The switches still in use: a feature that ships off is turned on or off again by an environment
 * change and a restart, with no deploy. Set as a list: `SHIPCAST_FLAGS=umami`. Every switch of the
 * performance refactor and of the launch model was retired once its path was the only one (RETIRED).
 */
export const FLAGS = {
  /** SHP-4: the blog's visits per launch and channel from Umami, until the Umami instance exists */
  umami: 'Blog visits by UTM source and campaign from Umami',
} as const;

/**
 * Flags that were turned on in production and then became the only path, their switch removed. An
 * environment that still lists one (an old SHIPCAST_FLAGS) starts as before: the name is accepted and
 * ignored rather than refused as unknown, so retiring a flag never needs an environment change first.
 */
const RETIRED: ReadonlySet<string> = new Set([
  // The AI task runner is the only AI layer (docs/decisions/ai-layer.md)
  'ai-runner',
  // The performance refactor (docs/plans/performance-refactor.md): every publish through PublishingService,
  // the secrets table selectable, Redis and BullMQ whenever SHIPCAST_REDIS_QUEUE_URL is set, GitHub by
  // events, the hourly metrics and the pages over server-sent events
  'publishing-service',
  'secrets-table',
  'redis-state',
  'bullmq',
  'github-events',
  'batched-metrics',
  'realtime-ui',
  // The launch model (docs/decisions/launch-model.md): every launch held by Shipcast, its media in the
  // media store, made from sources, by the trigger rules, deletable
  'launch-media',
  'launch-store',
  'launch-store-read',
  'app-review',
  'launch-sources',
  'launch-triggers',
  'launch-delete',
  // The import's write is `--apply` alone (scripts/import-launches.ts)
  'launch-import',
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
