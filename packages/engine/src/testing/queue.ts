import type { Repositories } from '../repositories/index.ts';

/*
 * A queue that runs nothing and records what was sent: what a handler or an entry point queues is
 * what a test asserts. It has the shape of the runtime's WorkQueue (send, upsert, schedule, queued,
 * registry) without its pg-boss, so a runtime test passes it `as unknown as WorkQueue`; the engine
 * cannot name that type, being below the runtime. Stately keys behave as pg-boss's do: a second
 * send of a key still queued is refused (null), an upsert moves the one queued.
 */

export interface RecordedJob {
  id: string;
  queue: string;
  data: unknown;
  options: { singletonKey?: string; startAfter?: number | Date; title?: string; launchId?: number | null };
  /** Whether a later upsert of the same key replaced it */
  replaced: boolean;
}

export class RecordingQueue {
  readonly jobs: RecordedJob[] = [];
  readonly schedules: Array<{ queue: string; cron: string; data: unknown; singletonKey?: string }> = [];
  readonly #registry: Repositories | undefined;
  #ids = 0;

  constructor(registry?: Repositories) {
    this.#registry = registry;
  }

  /** The registry the runtime's helpers read jobs back from; only there when the test gave one */
  get registry(): Repositories {
    if (!this.#registry) throw new Error('this RecordingQueue was built without a registry');
    return this.#registry;
  }

  #waiting(queue: string, key: string | undefined): RecordedJob | undefined {
    return key === undefined ? undefined : this.jobs.find((j) => j.queue === queue && j.options.singletonKey === key && !j.replaced);
  }

  async send(queue: string, data: unknown, options: RecordedJob['options'] = {}): Promise<string | null> {
    if (this.#waiting(queue, options.singletonKey)) return null;
    const id = `job-${++this.#ids}`;
    this.jobs.push({ id, queue, data, options, replaced: false });
    return id;
  }

  async upsert(queue: string, data: unknown, options: RecordedJob['options'] & { singletonKey: string }): Promise<string | null> {
    const queued = this.#waiting(queue, options.singletonKey);
    if (queued) queued.replaced = true;
    const id = `job-${++this.#ids}`;
    this.jobs.push({ id, queue, data, options, replaced: false });
    return id;
  }

  async schedule(queue: string, cron: string, data: unknown, options: { singletonKey?: string } = {}): Promise<void> {
    this.schedules.push({ queue, cron, data, ...(options.singletonKey !== undefined && { singletonKey: options.singletonKey }) });
  }

  async queued(queue: string, singletonKey?: string): Promise<string[]> {
    return this.waiting(queue)
      .filter((j) => singletonKey === undefined || j.options.singletonKey === singletonKey)
      .map((j) => j.id);
  }

  /** The jobs of one queue still waiting: not replaced by a later upsert */
  waiting(queue: string): RecordedJob[] {
    return this.jobs.filter((j) => j.queue === queue && !j.replaced);
  }
}
