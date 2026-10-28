import type { Registry } from './registry.ts';
import type { LaunchRepository } from './repositories/launches.ts';

/*
 * The narrow views of the registry each use case reads and writes (interface segregation,
 * docs/plans/performance-refactor.md, "Target architecture"). A service or an engine operation takes
 * the one it needs, never the whole Registry: a test fakes four methods instead of seventy-seven,
 * and when the Registry splits into repositories by aggregate each of these is what one of them
 * implements. They are Picks of Registry so the Registry itself fits every one meanwhile.
 */

/** Finding a launch by id */
export type LaunchLookup = Pick<LaunchRepository, 'get'>;

/** The launches as the pages list them: by id, the newest, and a filtered page with what its filters can offer */
export type LaunchCatalog = LaunchLookup & Pick<LaunchRepository, 'recent' | 'launchList' | 'launchFacets'>;

/** A launch's published pieces, read and marked edited or deleted */
export type PostStore = { launches: LaunchLookup } & Pick<Registry, 'post' | 'posts' | 'updatePost'>;

/** A setting row: the owner's choices stored as JSON (time zone, reply modes) */
export type SettingStore = Pick<Registry, 'setting' | 'setSetting'>;

/** A launch's scheduled pieces, with the cursor that remembers a channel cancelled, and the time zone */
export type ScheduleStore = { launches: LaunchLookup } & Pick<Registry, 'post' | 'posts' | 'schedulePost' | 'reschedulePost' | 'unschedulePost' | 'setCursor' | 'deleteCursor'> & SettingStore;

/** The comments a reply is drafted, edited or dismissed on */
export type CommentStore = Pick<Registry, 'comment' | 'commentByExternalId' | 'updateComment'>;

/** The comment list's reads, a page at a time with what its filters can offer */
export type CommentListing = Pick<Registry, 'comments' | 'commentsPage' | 'commentFacets' | 'commentPosts'>;

/** A single cursor written when something happened (the last metrics reading, the last round) */
export type CursorWriter = Pick<Registry, 'setCursor'>;

/** What a metrics reading reads and records: the published launches, their posts, the numbers and the cursors that pace the sources */
export type MetricStore = { launches: Pick<LaunchRepository, 'recent'> } & Pick<Registry, 'posts' | 'recordMetrics' | 'cursor' | 'setCursor'>;

/** The connected accounts, read, renamed and made the primary of their network */
export type AccountStore = Pick<Registry, 'account' | 'accounts' | 'primaryAccount' | 'updateAccount' | 'makePrimary'>;
