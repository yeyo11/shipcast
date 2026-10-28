import { and, asc, count, desc, eq, gte, ilike, inArray, like, lt, max, notInArray, or, sql, type SQL } from 'drizzle-orm';
import type { Channel, Language } from '@shipcast/schema';
import { connectPglite, connectPostgres, type Database } from './db/connect.ts';
import { LaunchRepository } from './repositories/launches.ts';
import { AssistantRepository } from './repositories/assistant.ts';
import { AttentionRepository } from './repositories/attention.ts';
import { ApiTokenRepository } from './repositories/api-tokens.ts';
import { CommentRepository } from './repositories/comments.ts';
import { JobRepository } from './repositories/jobs.ts';
import { AccountRepository } from './repositories/accounts.ts';
import { CursorRepository } from './repositories/cursors.ts';
import { SettingRepository } from './repositories/settings.ts';
import { MetricRepository } from './repositories/metrics.ts';
import { PostRepository } from './repositories/posts.ts';
import { RawQueries } from './repositories/sql.ts';
import { PublishAttempts } from './publishing/attempts.ts';
import { accounts, accountSnapshots, apiTokens, assistantMessages, assistantSessions, attentionDismissals, comments, cursors, jobs, launches, metrics, nowIso, posts, settings } from './db/schema.ts';

export * from './repositories/index.ts';

/**
 * The launch registry: the record that makes "a launch happens once" hold. A release is claimed
 * before anything is generated, and the claim is a unique row, so a second poll, a re-run or a
 * crash halfway through never starts the same campaign twice.
 *
 * It lives in Postgres, which the app, the CLI and the scheduler write to at once: what SQLite's
 * single writer made atomic for free is a transaction here.
 */
export class Registry {
  readonly #db: Database;
  readonly #close: () => Promise<void>;
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
  readonly attempts: PublishAttempts;
  readonly queries: RawQueries;

  /** Over a database whose schema is already migrated; `connect` and `memory` are the way in */
  constructor(db: Database, close: () => Promise<void> = async () => {}) {
    this.#db = db;
    this.#close = close;
    this.launches = new LaunchRepository(db);
    this.assistant = new AssistantRepository(db);
    this.attention = new AttentionRepository(db);
    this.apiTokens = new ApiTokenRepository(db);
    this.comments = new CommentRepository(db);
    this.jobs = new JobRepository(db);
    this.accounts = new AccountRepository(db);
    this.cursors = new CursorRepository(db);
    this.settings = new SettingRepository(db);
    this.metrics = new MetricRepository(db);
    this.posts = new PostRepository(db);
    this.attempts = new PublishAttempts(db);
    this.queries = new RawQueries(db);
  }

  /**
   * The connection, for the stores that sit beside the registry on the same schema and pool (the
   * measurement's, then the repositories the registry is split into)
   */
  get database(): Database {
    return this.#db;
  }

  /** The registry on a Postgres server (`SHIPCAST_DATABASE_URL`), its migrations applied */
  static async connect(url: string): Promise<Registry> {
    const { db, close } = await connectPostgres(url);
    return new Registry(db, close);
  }

  /**
   * The registry on PGlite, a real Postgres in this process: in memory and fresh on every call, or
   * kept in `dataDir`. What the tests run on, with no server to start.
   */
  static async memory(dataDir?: string): Promise<Registry> {
    const { db, close } = await connectPglite(dataDir);
    return new Registry(db, close);
  }

  async close(): Promise<void> {
    await this.#close();
  }
}
