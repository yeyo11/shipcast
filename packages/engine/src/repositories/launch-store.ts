import { and, desc, eq, inArray, isNull, max, or } from 'drizzle-orm';
import type { Database } from '../db/connect.ts';
import { approvals, drafts, draftVersions, launchChannels, launches, launchSources, media, nowIso, packs, posts } from '../db/schema.ts';
import { lockFor, transaction } from './transaction.ts';

/*
 * The tables of a launch held by Shipcast (docs/decisions/launch-model.md): its packs, channel rows,
 * drafts and their versions, media and approvals. Written by the shadow write of the model's second
 * phase (docs/launch-store.md) beside the pull-request flow, which still decides everything.
 */

/** Who wrote a version: the AI, the owner (in Shipcast or on the pull request), the assistant, an import or an edit after publishing */
export type DraftOrigin = 'ai' | 'owner' | 'assistant' | 'import' | 'post-publish-edit';

/** One piece's draft with its current version */
export interface StoredDraft {
  id: number;
  channel: string;
  piece: string;
  versionId: number;
  n: number;
  body: string;
  fields: Record<string, unknown>;
  origin: string;
}

export interface StoredPack {
  id: number;
  version: number;
  pack: Record<string, unknown>;
}

export interface ChannelRow {
  channel: string;
  mode: string;
  options?: Record<string, unknown>;
  note?: string | null;
}

export interface MediaInput {
  /** Null for a file no launch owns, such as a project's cover */
  launchId: number | null;
  sha256: string;
  kind: string;
  mime: string;
  bytes: number;
  storage: string;
  path: string;
  role: string;
  publicPath: string | null;
}

export interface StoredMediaRow extends MediaInput {
  id: number;
}

export interface StoredApproval {
  id: number;
  by: string;
  at: string;
  versions: Record<string, number>;
  note: string | null;
}

/** A version to add to a piece's draft, which is made on its first version */
export interface VersionInput {
  channel: string;
  piece: string;
  body: string;
  fields?: Record<string, unknown>;
  origin: DraftOrigin;
  author?: string | null;
  packId?: number | null;
  /** The import batch writing it (docs/launch-import.md): the draft too, when this version makes it */
  importBatch?: string;
}

/** What a launch is about, as `launch_sources` keeps it */
export interface SourceInput {
  position: number;
  kind: string;
  role: string;
  repo?: string | null;
  ref?: string | null;
  sha?: string | null;
  text?: string | null;
  meta?: Record<string, unknown>;
  contentHash?: string | null;
  importBatch?: string;
}

type MediaRow = typeof media.$inferSelect;
const mediaOf = (r: MediaRow): StoredMediaRow => ({
  id: r.id,
  launchId: r.launchId,
  sha256: r.sha256,
  kind: r.kind,
  mime: r.mime,
  bytes: r.bytes,
  storage: r.storage,
  path: r.path,
  role: r.role,
  publicPath: r.publicPath,
});

export class LaunchStoreRepository {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /** The launch's newest accepted pack, which is the current one */
  async currentPack(launchId: number): Promise<StoredPack | undefined> {
    const [row] = await this.#db
      .select({ id: packs.id, version: packs.version, pack: packs.pack })
      .from(packs)
      .where(and(eq(packs.launchId, launchId), eq(packs.accepted, true)))
      .orderBy(desc(packs.version))
      .limit(1);
    return row;
  }

  /** A pack the AI wrote, accepted as the current one: the next version of the launch's packs */
  addPack(launchId: number, pack: Record<string, unknown>, meta: { aiTask?: string | null; importBatch?: string } = {}): Promise<StoredPack> {
    return transaction(this.#db, async (tx) => {
      await lockFor(tx, `launch-store:${launchId}`);
      const [last] = await tx.select({ n: max(packs.version) }).from(packs).where(eq(packs.launchId, launchId));
      const [row] = await tx
        .insert(packs)
        .values({ launchId, version: (last?.n ?? 0) + 1, pack, aiTask: meta.aiTask ?? null, accepted: true, importBatch: meta.importBatch ?? null })
        .returning({ id: packs.id, version: packs.version, pack: packs.pack });
      return row!;
    });
  }

  /** The launch's channel rows, replaced as a whole, and the launch.yml they were read from */
  replaceChannels(launchId: number, rows: readonly ChannelRow[], source: string | null, importBatch?: string): Promise<void> {
    return transaction(this.#db, async (tx) => {
      await tx.delete(launchChannels).where(eq(launchChannels.launchId, launchId));
      if (rows.length > 0) {
        await tx.insert(launchChannels).values(rows.map((r) => ({ launchId, channel: r.channel, mode: r.mode, options: r.options ?? {}, note: r.note ?? null, importBatch: importBatch ?? null })));
      }
      await tx.update(launches).set({ channelsSource: source }).where(eq(launches.id, launchId));
    });
  }

  async channels(launchId: number): Promise<{ rows: ChannelRow[]; source: string | null }> {
    const [rows, [launch]] = await Promise.all([
      this.#db.select({ channel: launchChannels.channel, mode: launchChannels.mode, options: launchChannels.options, note: launchChannels.note }).from(launchChannels).where(eq(launchChannels.launchId, launchId)).orderBy(launchChannels.channel),
      this.#db.select({ source: launches.channelsSource }).from(launches).where(eq(launches.id, launchId)),
    ]);
    return { rows, source: launch?.source ?? null };
  }

  /** Every draft of the launch with its current version, by channel and piece */
  async drafts(launchId: number): Promise<StoredDraft[]> {
    return this.#db
      .select({
        id: drafts.id,
        channel: drafts.channel,
        piece: drafts.piece,
        versionId: draftVersions.id,
        n: draftVersions.n,
        body: draftVersions.body,
        fields: draftVersions.fields,
        origin: draftVersions.origin,
      })
      .from(drafts)
      .innerJoin(draftVersions, eq(draftVersions.id, drafts.currentVersionId))
      .where(eq(drafts.launchId, launchId))
      .orderBy(drafts.channel, drafts.piece);
  }

  /**
   * Adds a version to a piece's draft and makes it current, the draft made on its first. The draft is
   * locked while its next number is taken, so two writers of one piece never collide on it.
   */
  addVersion(launchId: number, input: VersionInput): Promise<{ draftId: number; versionId: number; n: number }> {
    return transaction(this.#db, async (tx) => {
      await tx.insert(drafts).values({ launchId, channel: input.channel, piece: input.piece, importBatch: input.importBatch ?? null }).onConflictDoNothing();
      const [draft] = await tx
        .select({ id: drafts.id })
        .from(drafts)
        .where(and(eq(drafts.launchId, launchId), eq(drafts.channel, input.channel), eq(drafts.piece, input.piece)))
        .for('update');
      const [last] = await tx.select({ n: max(draftVersions.n) }).from(draftVersions).where(eq(draftVersions.draftId, draft!.id));
      const n = (last?.n ?? 0) + 1;
      const [version] = await tx
        .insert(draftVersions)
        .values({ draftId: draft!.id, n, body: input.body, fields: input.fields ?? {}, origin: input.origin, author: input.author ?? null, packId: input.packId ?? null, importBatch: input.importBatch ?? null })
        .returning({ id: draftVersions.id });
      await tx.update(drafts).set({ currentVersionId: version!.id, updatedAt: nowIso }).where(eq(drafts.id, draft!.id));
      return { draftId: draft!.id, versionId: version!.id, n };
    });
  }

  /** Records a stored file; the same bytes twice under one owner are one row, the first kept */
  async addMedia(input: MediaInput & { importBatch?: string }): Promise<void> {
    await this.#db.insert(media).values(input).onConflictDoNothing();
  }

  /** Adds what the launch is about, at its position */
  async addSource(launchId: number, input: SourceInput): Promise<void> {
    await this.#db.insert(launchSources).values({ launchId, ...input });
  }

  /** The launch's files, and the shared ones (covers) at any of `publicPaths` */
  async media(launchId: number, publicPaths: readonly string[] = []): Promise<StoredMediaRow[]> {
    const own = eq(media.launchId, launchId);
    const where = publicPaths.length > 0 ? or(own, and(isNull(media.launchId), inArray(media.publicPath, [...publicPaths]))) : own;
    return (await this.#db.select().from(media).where(where).orderBy(media.id)).map(mediaOf);
  }

  /** A published piece now says this version of its draft (an edit after publishing) */
  async linkPost(postId: number, versionId: number): Promise<void> {
    await this.#db.update(posts).set({ draftVersionId: versionId }).where(eq(posts.id, postId));
  }

  /** One stored file by its row's id, whichever launch it is of */
  async mediaRow(id: number): Promise<StoredMediaRow | undefined> {
    const [row] = await this.#db.select().from(media).where(eq(media.id, id));
    return row && mediaOf(row);
  }

  /** The approval in force: the newest one not revoked */
  async approval(launchId: number): Promise<StoredApproval | undefined> {
    const [row] = await this.#db
      .select({ id: approvals.id, by: approvals.by, at: approvals.at, versions: approvals.versions, note: approvals.note })
      .from(approvals)
      .where(and(eq(approvals.launchId, launchId), isNull(approvals.revokedAt)))
      .orderBy(desc(approvals.at), desc(approvals.id))
      .limit(1);
    return row;
  }

  /**
   * Records an approval, and its time on the launch for the lists, unless one is in force already,
   * which is answered instead: two writers seeing the same merge record it once.
   */
  approveOnce(launchId: number, input: { by: string; at?: string; versions: Record<string, number>; note?: string | null; importBatch?: string }): Promise<StoredApproval> {
    return transaction(this.#db, async (tx) => {
      await lockFor(tx, `launch-store:${launchId}`);
      const [found] = await tx
        .select({ id: approvals.id, by: approvals.by, at: approvals.at, versions: approvals.versions, note: approvals.note })
        .from(approvals)
        .where(and(eq(approvals.launchId, launchId), isNull(approvals.revokedAt)))
        .limit(1);
      if (found) return found;
      const [row] = await tx
        .insert(approvals)
        .values({ launchId, by: input.by, versions: input.versions, note: input.note ?? null, importBatch: input.importBatch ?? null, ...(input.at && { at: input.at }) })
        .returning({ id: approvals.id, by: approvals.by, at: approvals.at, versions: approvals.versions, note: approvals.note });
      await tx.update(launches).set({ approvedAt: row!.at }).where(eq(launches.id, launchId));
      return row!;
    });
  }

  /**
   * The owner approves the launch in the app (docs/app-review.md): the versions named are the ones
   * approved, and the approval in force before is revoked, so the newest approval is the one that
   * counts. An approval already naming exactly these versions is answered instead of a second row.
   */
  approve(launchId: number, input: { by: string; versions: Record<string, number>; note?: string | null }): Promise<StoredApproval> {
    return transaction(this.#db, async (tx) => {
      await lockFor(tx, `launch-store:${launchId}`);
      const columns = { id: approvals.id, by: approvals.by, at: approvals.at, versions: approvals.versions, note: approvals.note };
      const [found] = await tx
        .select(columns)
        .from(approvals)
        .where(and(eq(approvals.launchId, launchId), isNull(approvals.revokedAt)))
        .orderBy(desc(approvals.at), desc(approvals.id))
        .limit(1);
      if (found && sameVersions(found.versions, input.versions)) return found;
      await tx.update(approvals).set({ revokedAt: nowIso }).where(and(eq(approvals.launchId, launchId), isNull(approvals.revokedAt)));
      const [row] = await tx.insert(approvals).values({ launchId, by: input.by, versions: input.versions, note: input.note ?? null }).returning(columns);
      await tx.update(launches).set({ approvedAt: row!.at }).where(eq(launches.id, launchId));
      return row!;
    });
  }
}

const sameVersions = (a: Record<string, number>, b: Record<string, number>) => Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([k, v]) => b[k] === v);
