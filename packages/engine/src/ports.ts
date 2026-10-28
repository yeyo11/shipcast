import type { AccountRepository } from './repositories/accounts.ts';
import type { CommentRepository } from './repositories/comments.ts';
import type { CursorRepository } from './repositories/cursors.ts';
import type { LaunchRepository } from './repositories/launches.ts';
import type { MetricRepository } from './repositories/metrics.ts';
import type { PostRepository } from './repositories/posts.ts';
import type { SettingRepository } from './repositories/settings.ts';

/*
 * The narrow views of the registry each use case reads and writes (interface segregation,
 * docs/plans/performance-refactor.md, "Target architecture"). A service or an engine operation takes
 * the one it needs, never every repository: a test fakes the four methods it touches. A port over
 * one aggregate is a Pick of its repository; one over several is shaped as a Pick of Repositories
 * (`{ launches, posts }`), so the bundle a composition root holds fits every one of them as it is.
 */

/** Finding a launch by id */
export type LaunchLookup = Pick<LaunchRepository, 'get'>;

/** The launches as the pages list them: by id, the newest, and a filtered page with what its filters can offer */
export type LaunchCatalog = LaunchLookup & Pick<LaunchRepository, 'recent' | 'launchList' | 'launchFacets'>;

/** A launch's published pieces, read and marked edited or deleted */
export type PostStore = { launches: LaunchLookup; posts: Pick<PostRepository, 'post' | 'posts' | 'updatePost'> };

/** A setting row: the owner's choices stored as JSON (time zone, reply modes) */
export type SettingStore = { settings: Pick<SettingRepository, 'setting' | 'setSetting'> };

/** Reading a setting only */
export type SettingReader = { settings: Pick<SettingRepository, 'setting'> };

/** A launch's scheduled pieces, with the cursor that remembers a channel cancelled, and the time zone */
export type ScheduleStore = { launches: LaunchLookup; posts: Pick<PostRepository, 'post' | 'posts' | 'schedulePost' | 'reschedulePost' | 'unschedulePost'> ; cursors: Pick<CursorRepository, 'setCursor' | 'deleteCursor'> } & SettingStore;

/** The comments a reply is drafted, edited or dismissed on */
export type CommentStore = { comments: Pick<CommentRepository, 'comment' | 'commentByExternalId' | 'updateComment'> };

/** The comment list's reads, a page at a time with what its filters can offer */
export type CommentListing = { comments: Pick<CommentRepository, 'comments' | 'commentsPage' | 'commentFacets' | 'commentPosts'> };

/** A single cursor written when something happened (the last metrics reading, the last round) */
export type CursorWriter = { cursors: Pick<CursorRepository, 'setCursor'> };

/** What a metrics reading reads and records: the published launches, their posts, the numbers and the cursors that pace the sources */
export type MetricStore = { launches: Pick<LaunchRepository, 'recent'>; posts: Pick<PostRepository, 'posts'>; metrics: Pick<MetricRepository, 'recordMetrics'>; cursors: Pick<CursorRepository, 'cursor' | 'setCursor'> };

/** The connected accounts, read, renamed and made the primary of their network */
export type AccountStore = Pick<AccountRepository, 'account' | 'accounts' | 'primaryAccount' | 'updateAccount' | 'makePrimary'>;
