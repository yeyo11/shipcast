import { connectPglite, connectPostgres, type Database } from '../db/connect.ts';
import { PublishAttempts } from '../publishing/attempts.ts';
import { LaunchRepository } from './launches.ts';
import { AssistantRepository } from './assistant.ts';
import { AttentionRepository } from './attention.ts';
import { ApiTokenRepository } from './api-tokens.ts';
import { CommentRepository } from './comments.ts';
import { JobRepository } from './jobs.ts';
import { AccountRepository } from './accounts.ts';
import { CursorRepository } from './cursors.ts';
import { SettingRepository } from './settings.ts';
import { MetricRepository } from './metrics.ts';
import { PostRepository } from './posts.ts';
import { RawQueries } from './sql.ts';
import { transaction } from './transaction.ts';

/*
 * The launch registry, split by aggregate (docs/plans/performance-refactor.md, phase 4): one
 * repository per aggregate, each a class over a Database on the same Drizzle schema. A consumer
 * takes the ones it uses (a Pick of Repositories, or one of the ports in ports.ts), never the whole
 * set; only a composition root (the app's context, the CLI, the runtime, the CI mode) holds them all.
 *
 * The registry is what makes "a launch happens once" hold: a release is claimed before anything is
 * generated, and the claim is a unique row, so a second poll, a re-run or a crash halfway through
 * never starts the same campaign twice. It lives in Postgres, which the app, the CLI and the
 * scheduler write to at once: what SQLite's single writer made atomic for free is a transaction here.
 */

export * from './launches.ts';
export * from './assistant.ts';
export * from './attention.ts';
export * from './api-tokens.ts';
export * from './comments.ts';
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
  readonly assistant: AssistantRepository;
  readonly attention: AttentionRepository;
  readonly apiTokens: ApiTokenRepository;
  readonly comments: CommentRepository;
  readonly jobs: JobRepository;
  readonly accounts: AccountRepository;
  readonly cursors: CursorRepository;
  readonly settings: SettingRepository;
  readonly metrics: MetricRepository;
  readonly posts: PostRepository;
  /** The posts' publish attempts, the outbox a worker claims a piece in before it calls the network */
  readonly attempts: PublishAttempts;
  /** The read-only SQL the query builder cannot say, for the reports and the checks */
  readonly queries: RawQueries;
}

/** The repositories over `db`: a pool, a PGlite, or a transaction */
export function repositoriesOn(db: Database): Repositories {
  return {
    database: db,
    launches: new LaunchRepository(db),
    assistant: new AssistantRepository(db),
    attention: new AttentionRepository(db),
    apiTokens: new ApiTokenRepository(db),
    comments: new CommentRepository(db),
    jobs: new JobRepository(db),
    accounts: new AccountRepository(db),
    cursors: new CursorRepository(db),
    settings: new SettingRepository(db),
    metrics: new MetricRepository(db),
    posts: new PostRepository(db),
    attempts: new PublishAttempts(db),
    queries: new RawQueries(db),
  };
}

/**
 * Runs `work` in one transaction, with every repository over it: what a use case that writes
 * through several aggregates at once uses so either all of it lands or none of it does.
 */
export function inTransaction<T>(repositories: Pick<Repositories, 'database'>, work: (tx: Repositories) => Promise<T>): Promise<T> {
  return transaction(repositories.database, (db) => work(repositoriesOn(db)));
}

/** The repositories over a connection this process opened, and the way to close it */
export interface OpenRepositories extends Repositories {
  close(): Promise<void>;
}

/** The registry on a Postgres server (`SHIPCAST_DATABASE_URL`), its migrations applied */
export async function connectRepositories(url: string): Promise<OpenRepositories> {
  const { db, close } = await connectPostgres(url);
  return { ...repositoriesOn(db), close };
}

/**
 * The registry on PGlite, a real Postgres in this process: in memory and fresh on every call, or
 * kept in `dataDir`. What the tests run on, with no server to start.
 */
export async function memoryRepositories(dataDir?: string): Promise<OpenRepositories> {
  const { db, close } = await connectPglite(dataDir);
  return { ...repositoriesOn(db), close };
}
