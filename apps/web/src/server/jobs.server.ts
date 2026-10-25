import { randomUUID } from 'node:crypto';

export type JobState = 'running' | 'done' | 'failed';

export interface Job {
  id: string;
  /** What it is, in words: "Drafting yeyo11/claudio v0.9.0" */
  title: string;
  state: JobState;
  /** Lines worth showing while it runs, and its outcome */
  log: string[];
  /** Where to go once it is done: a pull request, a launch */
  link?: string;
  startedAt: string;
  endedAt?: string;
}

/**
 * Work that outlives a request: drafting a launch takes minutes, publishing waits for the site to
 * deploy. Jobs run in the app's process and are kept in memory; the registry holds what matters.
 */
export class Jobs {
  readonly #jobs = new Map<string, Job>();

  start(title: string, work: (log: (line: string) => void, job: Job) => Promise<string | undefined | void>): Job {
    const job: Job = { id: randomUUID(), title, state: 'running', log: [], startedAt: new Date().toISOString() };
    this.#jobs.set(job.id, job);
    const log = (line: string) => job.log.push(line);
    work(log, job).then(
      (link) => {
        job.state = 'done';
        if (link) job.link = link;
        job.endedAt = new Date().toISOString();
      },
      (error: unknown) => {
        job.state = 'failed';
        job.log.push(error instanceof Error ? error.message : String(error));
        job.endedAt = new Date().toISOString();
      },
    );
    return job;
  }

  get(id: string): Job | undefined {
    return this.#jobs.get(id);
  }

  /** The newest first; finished jobs older than a day are forgotten */
  list(): Job[] {
    const day = Date.now() - 86_400_000;
    for (const [id, job] of this.#jobs) if (job.endedAt && Date.parse(job.endedAt) < day) this.#jobs.delete(id);
    return [...this.#jobs.values()].reverse();
  }
}
