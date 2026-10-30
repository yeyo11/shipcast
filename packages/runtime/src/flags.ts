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
  /**
   * Launch model (docs/decisions/launch-model.md), phase 1: the media store on Cloudflare R2, built
   * from SHIPCAST_MEDIA_* in .env. Off, the store refuses every call; nothing calls it yet
   */
  'launch-media': 'Launch media in the R2 media store',
  /**
   * Launch model, phase 2: the drafts pull request's pack, channels, drafts (as versions), media and
   * merge are also written to the launch model's tables and checked against it (docs/launch-store.md).
   * Read only with `launch-store-read`; its media need `launch-media` too
   */
  'launch-store': 'Launch model shadow write beside the drafts pull request',
  /**
   * Launch model, phase 3: scripts/import-launches.ts may write (docs/launch-import.md): import the
   * launches drafted before the shadow write, delete the ones decided, roll a batch back. Off, it only
   * plans and verifies; the app never reads it
   */
  'launch-import': 'Import of the existing launches into the launch model (scripts/import-launches.ts)',
  /**
   * Launch model, phase 4: the launch page, the REST API (and MCP), scheduling's channels and the
   * reply and writing assistants' grounding read the launch model's tables instead of GitHub
   * (docs/launch-store-read.md); a launch they do not hold is read as before. Needs `launch-store`,
   * which keeps them up to date, and `launch-media` for its files
   */
  'launch-store-read': 'Launches read from the launch model instead of GitHub',
  /**
   * Launch model, phase 5: a new launch has no pull request. Its drafts are reviewed, edited (as
   * versions), previewed and approved in the app, `auto` channels go out without approval, and the
   * article and its media reach the launches repo as one commit when it is published
   * (docs/app-review.md). Needs `launch-store-read` (with `launch-store`) and `launch-media`
   */
  'app-review': 'Launches reviewed and approved in the app, with no pull request',
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
