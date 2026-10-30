import { and, asc, count, desc, eq, ilike, isNull, or, sql, type SQL } from 'drizzle-orm';
import { PackKind } from '@shipcast/schema';
import type { Database } from '../db/connect.ts';
import { launches, nowIso } from '../db/schema.ts';
import { likePattern } from './sql.ts';

/** What started a launch; the launch.yml `triggers` decide which of these are honoured. An `article` is written in the app, not released. */
export type Trigger = 'release' | 'manual' | 'public' | 'enabled' | 'article';

/**
 * The life of a launch. `skipped` and `failed` keep their row, so a release that was deliberately
 * not launched is never picked up again by the next poll.
 */
export type LaunchStatus = 'detected' | 'generating' | 'drafted' | 'published' | 'skipped' | 'failed';

/**
 * Who holds a launch's drafts (docs/decisions/launch-model.md): `legacy`, a pull request in the
 * launches repo that is approved by its merge; `app`, Shipcast itself, reviewed and approved in the
 * app (docs/app-review.md)
 */
export type LaunchModel = 'legacy' | 'app';

export interface Launch {
  id: number;
  /** `owner/name` */
  repo: string;
  /** The release tag, or for a launch without one a key of its own (see claim) */
  ref: string;
  trigger: Trigger;
  kind: PackKind;
  brand: string;
  status: LaunchStatus;
  /** Why it was skipped or failed, or where its drafts are */
  detail: string | null;
  createdAt: string;
  updatedAt: string;
  /** Always set on a launch read from the registry; a launch built without it is `legacy` */
  model?: LaunchModel;
  /**
   * When the owner deleted it, a launch that had published (docs/launch-delete.md): hidden from the
   * lists, the rounds and the metrics, its row kept so it is never launched again. Absent otherwise
   */
  deletedAt?: string;
}

export const LAUNCH_STATUSES: readonly LaunchStatus[] = ['detected', 'generating', 'drafted', 'published', 'skipped', 'failed'];
export const TRIGGERS: readonly Trigger[] = ['release', 'manual', 'public', 'enabled', 'article'];

/** The launches' two orders, both on (created_at, id): the newest first, or the oldest first */
export type LaunchOrder = 'newest' | 'oldest';
export const LAUNCH_ORDERS: readonly LaunchOrder[] = ['newest', 'oldest'];

/** What narrows the launches list; every field is optional and they all hold together */
export interface LaunchFilter {
  status?: LaunchStatus;
  trigger?: Trigger;
  kind?: PackKind;
  /** `owner/name`, exactly */
  repo?: string;
  /** Words to find in the repo, the ref or an article's title, case-insensitive */
  search?: string;
  order?: LaunchOrder;
}

/** A position in the launches' order: the last launch of a page */
export interface LaunchCursor {
  createdAt: string;
  id: number;
}

/** One numbered page of the launches list; `page` counts from 1 */
export interface LaunchPage {
  launches: Launch[];
  /** Every launch the filter matches, not only this page's */
  total: number;
  page: number;
  pageSize: number;
  pages: number;
}

/** What the list's filters can offer: only the values some launch has, with how many */
export interface LaunchFacets {
  repos: Array<{ repo: string; count: number }>;
  statuses: Array<{ status: LaunchStatus; count: number }>;
  triggers: Array<{ trigger: Trigger; count: number }>;
  kinds: Array<{ kind: PackKind; count: number }>;
}

export interface NewLaunch {
  repo: string;
  ref: string;
  trigger: Trigger;
  kind: PackKind;
  brand: string;
  /** What the app lists it as; a launch made from sources has one (launch-sources) */
  title?: string;
  /** The launch.yml a launch with no repo publishes by (launch-sources) */
  channelsSource?: string;
  /**
   * What "a launch happens once" is also checked on (`launches.dedupe_key`, docs/launch-triggers.md):
   * a claim whose key is taken finds that launch, whatever its repo and ref
   */
  dedupeKey?: string;
}


/**
 * Words as an article's ref holds its title (`article:<slug>`, see article.ts' `articleSlug`): the
 * title is only in the ref, so "Hello, world" finds `article:hello-world`
 */
const slugOf = (words: string) =>
  words
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

function toLaunch(row: typeof launches.$inferSelect): Launch {
  return {
    id: row.id,
    repo: row.repo,
    ref: row.ref,
    trigger: row.trigger as Trigger,
    kind: row.kind as PackKind,
    brand: row.brand,
    status: row.status as LaunchStatus,
    detail: row.detail,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    model: row.model === 'app' ? 'app' : 'legacy',
    ...(row.deletedAt !== null && { deletedAt: row.deletedAt }),
  };
}

// The lists, the rounds and the metrics leave out a launch the owner deleted (docs/launch-delete.md)
const shown = isNull(launches.deletedAt);

/**
 * The launches: the record that makes "a launch happens once" hold. A release is claimed before
 * anything is generated, and the claim is a unique row, so a second poll, a re-run or a crash
 * halfway through never starts the same campaign twice.
 */
export class LaunchRepository {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /**
   * Records a launch unless one exists for the same repo and ref. `claimed: false` returns the
   * existing launch, whatever its status: the caller does nothing with a release it did not claim.
   * `ON CONFLICT` waits for a concurrent claim of the same release to commit, so only one wins.
   */
  async claim(launch: NewLaunch): Promise<{ claimed: boolean; launch: Launch }> {
    const values = { repo: launch.repo, ref: launch.ref, trigger: launch.trigger, kind: launch.kind, brand: launch.brand, status: 'detected', ...(launch.title !== undefined && { title: launch.title }), ...(launch.channelsSource !== undefined && { channelsSource: launch.channelsSource }) };
    if (launch.dedupeKey !== undefined) {
      // Either unique key taken is the same launch: a release by its repo and tag, or by its key
      const [keyed] = await this.#db.insert(launches).values({ ...values, dedupeKey: launch.dedupeKey }).onConflictDoNothing().returning();
      if (keyed) return { claimed: true, launch: toLaunch(keyed) };
      return { claimed: false, launch: ((await this.find(launch.repo, launch.ref)) ?? (await this.findByDedupeKey(launch.dedupeKey)))! };
    }
    const [inserted] = await this.#db.insert(launches).values(values).onConflictDoNothing({ target: [launches.repo, launches.ref] }).returning();
    if (inserted) return { claimed: true, launch: toLaunch(inserted) };
    return { claimed: false, launch: (await this.find(launch.repo, launch.ref))! };
  }

  /** A launch's title and the launch.yml it publishes by, as the launch model keeps them; undefined for no such launch */
  async modelFields(id: number): Promise<{ title: string | null; channelsSource: string | null } | undefined> {
    const [row] = await this.#db.select({ title: launches.title, channelsSource: launches.channelsSource }).from(launches).where(eq(launches.id, id));
    return row;
  }

  /** Names a launch again and sets the launch.yml it publishes by: a failed launch made from sources, asked for again */
  async setModelFields(id: number, fields: { title: string; channelsSource: string | null }): Promise<void> {
    await this.#db.update(launches).set({ title: fields.title, channelsSource: fields.channelsSource, updatedAt: nowIso }).where(eq(launches.id, id));
  }

  async findByDedupeKey(key: string): Promise<Launch | undefined> {
    const [row] = await this.#db.select().from(launches).where(eq(launches.dedupeKey, key));
    return row ? toLaunch(row) : undefined;
  }

  /** The launch's dedupe key as stored; null for one claimed before the launch model, or by hand */
  async dedupeKey(id: number): Promise<string | null> {
    const [row] = await this.#db.select({ key: launches.dedupeKey }).from(launches).where(eq(launches.id, id));
    return row?.key ?? null;
  }

  /** Hides a published launch the owner deleted (docs/launch-delete.md); its row and its posts stay */
  async hide(id: number): Promise<Launch> {
    const [row] = await this.#db.update(launches).set({ deletedAt: nowIso, updatedAt: nowIso }).where(eq(launches.id, id)).returning();
    if (!row) throw new Error(`no launch with id ${id}`);
    return toLaunch(row);
  }

  async find(repo: string, ref: string): Promise<Launch | undefined> {
    const [row] = await this.#db
      .select()
      .from(launches)
      .where(and(eq(launches.repo, repo), eq(launches.ref, ref)));
    return row ? toLaunch(row) : undefined;
  }

  async get(id: number): Promise<Launch | undefined> {
    const [row] = await this.#db.select().from(launches).where(eq(launches.id, id));
    return row ? toLaunch(row) : undefined;
  }

  /** The newest launches first, for `shipcast status`; one the owner deleted is left out. */
  async recent(limit = 20): Promise<Launch[]> {
    const rows = await this.#db.select().from(launches).where(shown).orderBy(desc(launches.createdAt), desc(launches.id)).limit(limit);
    return rows.map(toLaunch);
  }

  async setStatus(id: number, status: LaunchStatus, detail: string | null = null): Promise<Launch> {
    const [row] = await this.#db.update(launches).set({ status, detail, updatedAt: nowIso }).where(eq(launches.id, id)).returning();
    if (!row) throw new Error(`no launch with id ${id}`);
    return toLaunch(row);
  }

  /** The launch's drafts are held by `model` from now on (docs/app-review.md) */
  async setModel(id: number, model: LaunchModel): Promise<Launch> {
    const [row] = await this.#db.update(launches).set({ model, updatedAt: nowIso }).where(eq(launches.id, id)).returning();
    if (!row) throw new Error(`no launch with id ${id}`);
    return toLaunch(row);
  }

  /**
   * The ref of the repo's last launch that reached its audience, to infer the next pack: a project
   * that never launched gets the `launch` pack, whatever its version number says.
   */
  async lastPublishedRef(repo: string): Promise<string | undefined> {
    const [row] = await this.#db
      .select({ ref: launches.ref })
      .from(launches)
      .where(and(eq(launches.repo, repo), eq(launches.status, 'published')))
      .orderBy(desc(launches.createdAt), desc(launches.id))
      .limit(1);
    return row?.ref;
  }

  /**
   * The launch filter as conditions. Status and repo have an index each that also holds the order
   * (migration 0010); the words are a LIKE over the repo and the ref, which no btree serves, and
   * scan a table that has one row per release, small next to comments or metrics.
   */
  #launchConditions(filter: LaunchFilter): SQL[] {
    const where: SQL[] = [shown];
    if (filter.status !== undefined) where.push(eq(launches.status, filter.status));
    if (filter.trigger !== undefined) where.push(eq(launches.trigger, filter.trigger));
    if (filter.kind !== undefined) where.push(eq(launches.kind, filter.kind));
    if (filter.repo !== undefined) where.push(eq(launches.repo, filter.repo));
    const words = filter.search?.trim();
    if (words) {
      const slug = slugOf(words);
      const match = or(
        ilike(launches.repo, likePattern(words)),
        ilike(launches.ref, likePattern(words)),
        ...(slug && slug !== words.toLowerCase() ? [ilike(launches.ref, likePattern(slug))] : []),
      );
      if (match) where.push(match);
    }
    return where;
  }

  #launchOrder(order: LaunchOrder = 'newest') {
    return order === 'oldest' ? [asc(launches.createdAt), asc(launches.id)] : [desc(launches.createdAt), desc(launches.id)];
  }

  /**
   * A page of launches for the REST API, the newest first unless asked otherwise. Keyset paging on
   * (created_at, id), the order `recent` uses, so a launch claimed while a client pages never shifts
   * or repeats a page. `after` is the last launch of the previous page in the same order.
   */
  async launchesPage(options: LaunchFilter & { limit: number; after?: LaunchCursor }): Promise<{ launches: Launch[]; next?: LaunchCursor }> {
    const where = this.#launchConditions(options);
    if (options.after) {
      const position = sql`(${launches.createdAt}, ${launches.id})`;
      const after = sql`(${options.after.createdAt}, ${options.after.id})`;
      where.push(options.order === 'oldest' ? sql`${position} > ${after}` : sql`${position} < ${after}`);
    }
    const rows = await this.#db
      .select()
      .from(launches)
      .where(and(...where))
      .orderBy(...this.#launchOrder(options.order))
      .limit(options.limit + 1);
    const page = rows.slice(0, options.limit).map(toLaunch);
    const last = page.at(-1);
    return rows.length > options.limit && last ? { launches: page, next: { createdAt: last.createdAt, id: last.id } } : { launches: page };
  }

  /**
   * One numbered page of launches for the Launches page: the filter is one WHERE, the total a count
   * of it, so the list is never read whole to be paged. Numbered (offset) rather than keyset because
   * the page shows "Page 2 of 5" and keeps the page in its address; the launches are few enough that
   * the offset costs nothing, and the API keeps its cursor for clients that walk the whole list.
   */
  async launchList(filter: LaunchFilter & { page?: number; pageSize?: number } = {}): Promise<LaunchPage> {
    const where = this.#launchConditions(filter);
    const condition = and(...where);
    const pageSize = Math.min(Math.max(Math.trunc(filter.pageSize ?? 24), 1), 100);
    const [totalRow] = await this.#db.select({ n: count() }).from(launches).where(condition);
    const total = Number(totalRow?.n ?? 0);
    const pages = Math.max(1, Math.ceil(total / pageSize));
    // A page past the end (a link kept after the list shrank) shows the last one
    const page = Math.min(Math.max(Math.trunc(filter.page ?? 1), 1), pages);
    const rows = await this.#db
      .select()
      .from(launches)
      .where(condition)
      .orderBy(...this.#launchOrder(filter.order))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    return { launches: rows.map(toLaunch), total, page, pageSize, pages };
  }

  /** The options of the list's filters, from grouped counts whatever the number of launches */
  async launchFacets(): Promise<LaunchFacets> {
    const [repos, statuses, triggers, kinds] = await Promise.all([
      this.#db.select({ value: launches.repo, n: count() }).from(launches).where(shown).groupBy(launches.repo).orderBy(asc(launches.repo)),
      this.#db.select({ value: launches.status, n: count() }).from(launches).where(shown).groupBy(launches.status),
      this.#db.select({ value: launches.trigger, n: count() }).from(launches).where(shown).groupBy(launches.trigger),
      this.#db.select({ value: launches.kind, n: count() }).from(launches).where(shown).groupBy(launches.kind),
    ]);
    // In the vocabulary's own order, not the database's, so the options never move around
    const ordered = <T extends string>(rows: Array<{ value: string; n: number }>, known: readonly T[]) =>
      known.flatMap((value) => {
        const row = rows.find((r) => r.value === value);
        return row ? [{ value, count: Number(row.n) }] : [];
      });
    return {
      repos: repos.map((r) => ({ repo: r.value, count: Number(r.n) })),
      statuses: ordered(statuses, LAUNCH_STATUSES).map((r) => ({ status: r.value, count: r.count })),
      triggers: ordered(triggers, TRIGGERS).map((r) => ({ trigger: r.value, count: r.count })),
      kinds: ordered(kinds, PackKind.options).map((r) => ({ kind: r.value, count: r.count })),
    };
  }
}
