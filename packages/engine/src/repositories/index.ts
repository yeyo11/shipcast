import type { Database } from '../db/connect.ts';
import { LaunchRepository } from './launches.ts';
import { JobRepository } from './jobs.ts';
import { AccountRepository } from './accounts.ts';
import { CursorRepository } from './cursors.ts';
import { SettingRepository } from './settings.ts';
import { MetricRepository } from './metrics.ts';
import { PostRepository } from './posts.ts';
import { transaction } from './transaction.ts';

/*
 * The registry split by aggregate (docs/plans/performance-refactor.md, phase 4): one repository per
 * aggregate, each a class over a Database on the same Drizzle schema. A consumer takes the ones it
 * uses (a Pick of Repositories, or one of the ports in ports.ts), never the whole set.
 */

export * from './launches.ts';
export * from './jobs.ts';
export * from './accounts.ts';
export * from './cursors.ts';
export * from './settings.ts';
export * from './metrics.ts';
export * from './posts.ts';
export * from './sql.ts';
export * from './transaction.ts';

/** Every repository over one connection (or one transaction), built once by a composition root */
export interface Repositories {
  /** The connection, for the stores that sit beside the repositories on the same schema and pool */
  readonly database: Database;
  readonly launches: LaunchRepository;
  readonly jobs: JobRepository;
  readonly accounts: AccountRepository;
  readonly cursors: CursorRepository;
  readonly settings: SettingRepository;
  readonly metrics: MetricRepository;
  readonly posts: PostRepository;
}

/** The repositories over `db`: a pool, a PGlite, or a transaction */
export function repositoriesOn(db: Database): Repositories {
  return {
    database: db,
    launches: new LaunchRepository(db),
    jobs: new JobRepository(db),
    accounts: new AccountRepository(db),
    cursors: new CursorRepository(db),
    settings: new SettingRepository(db),
    metrics: new MetricRepository(db),
    posts: new PostRepository(db),
  };
}

/**
 * Runs `work` in one transaction, with every repository over it: what a use case that writes
 * through several aggregates at once uses so either all of it lands or none of it does.
 */
export function inTransaction<T>(repositories: Pick<Repositories, 'database'>, work: (tx: Repositories) => Promise<T>): Promise<T> {
  return transaction(repositories.database, (db) => work(repositoriesOn(db)));
}
