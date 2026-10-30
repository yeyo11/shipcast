import { and, asc, eq, inArray, isNotNull, isNull, ne } from 'drizzle-orm';
import type { Database } from '../db/connect.ts';
import { launchSources, media } from '../db/schema.ts';
import { transaction } from './transaction.ts';

/*
 * What a launch is about (launch-sources, docs/sources.md): its sources in order, and the files the
 * owner uploaded for them. The rows are the launch model's (migration 0018); this is their first
 * reader and writer.
 */

/**
 * `repo_release`: a repo at a release tag (the primary repo, whose release is the launch); `repo`: a
 * further repo at its default branch; `repo_ref`: a further repo at a named ref; `url`: a page
 * Shipcast fetched; `text`: the owner's own words; `media`: an uploaded file
 */
export type SourceKind = 'repo_release' | 'repo_ref' | 'repo' | 'url' | 'text' | 'media';
/** The primary repo is the project: its release triggers the launch, its Discussions and stars are the launch's */
export type SourceRole = 'primary' | 'context';

export const REPO_KINDS: readonly SourceKind[] = ['repo_release', 'repo_ref', 'repo'];

/** An uploaded file as the media table keeps it */
export interface SourceMedia {
  id: number;
  sha256: string;
  kind: string;
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  storage: string;
  path: string;
}

export interface LaunchSource {
  id: number;
  launchId: number;
  /** 1, 2, 3…: the order the owner gave, and the source's id for the analysis (`S<position>`) */
  position: number;
  kind: SourceKind;
  role: SourceRole;
  repo: string | null;
  ref: string | null;
  /** The commit the analysis read, frozen at the first draft */
  sha: string | null;
  url: string | null;
  fetchedAt: string | null;
  httpStatus: number | null;
  contentType: string | null;
  /** The owner's words, or a fetched page as Markdown */
  text: string | null;
  media: SourceMedia | null;
  /** A page's title, a file's name and alt text, a text's title */
  meta: Record<string, unknown>;
  contentHash: string | null;
}

export type NewLaunchSource = Pick<LaunchSource, 'kind' | 'role'> &
  Partial<Pick<LaunchSource, 'repo' | 'ref' | 'url' | 'fetchedAt' | 'httpStatus' | 'contentType' | 'text' | 'meta' | 'contentHash'>> & {
    /** An uploaded file's `media` row; null for every other kind */
    mediaId?: number | null;
  };

/** A file uploaded for a launch not created yet: the media row no launch owns, until a launch takes it */
export type NewUpload = Omit<SourceMedia, 'id'>;

type SourceRow = typeof launchSources.$inferSelect;
type MediaRow = typeof media.$inferSelect;

const toMedia = (row: MediaRow): SourceMedia => ({
  id: row.id,
  sha256: row.sha256,
  kind: row.kind,
  mime: row.mime,
  bytes: row.bytes,
  width: row.width,
  height: row.height,
  storage: row.storage,
  path: row.path,
});

const toSource = (row: SourceRow, file: MediaRow | null): LaunchSource => ({
  id: row.id,
  launchId: row.launchId,
  position: row.position,
  kind: row.kind as SourceKind,
  role: row.role as SourceRole,
  repo: row.repo,
  ref: row.ref,
  sha: row.sha,
  url: row.url,
  fetchedAt: row.fetchedAt,
  httpStatus: row.httpStatus,
  contentType: row.contentType,
  text: row.text,
  media: file ? toMedia(file) : null,
  meta: row.meta,
  contentHash: row.contentHash,
});

export class LaunchSourceRepository {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /** A launch's sources in order, each uploaded file with its media row */
  async list(launchId: number): Promise<LaunchSource[]> {
    const rows = await this.#db
      .select({ source: launchSources, file: media })
      .from(launchSources)
      .leftJoin(media, eq(media.id, launchSources.mediaId))
      .where(eq(launchSources.launchId, launchId))
      .orderBy(asc(launchSources.position));
    return rows.map((r) => toSource(r.source, r.file));
  }

  /**
   * Sets a launch's sources, numbered in the order given: what creating a launch writes, and what a
   * failed one asked for again rewrites. One transaction, so a launch never has half its sources.
   */
  async replace(launchId: number, sources: readonly NewLaunchSource[]): Promise<LaunchSource[]> {
    await transaction(this.#db, async (tx) => {
      await tx.delete(launchSources).where(eq(launchSources.launchId, launchId));
      if (sources.length === 0) return;
      await tx.insert(launchSources).values(
        sources.map((s, i) => ({
          launchId,
          position: i + 1,
          kind: s.kind,
          role: s.role,
          repo: s.repo ?? null,
          ref: s.ref ?? null,
          url: s.url ?? null,
          fetchedAt: s.fetchedAt ?? null,
          httpStatus: s.httpStatus ?? null,
          contentType: s.contentType ?? null,
          text: s.text ?? null,
          mediaId: s.mediaId ?? null,
          meta: s.meta ?? {},
          contentHash: s.contentHash ?? null,
        })),
      );
    });
    return this.list(launchId);
  }

  /** Each launch's further repos (every repo source but the primary), by launch id: whose numbers are read per repo */
  async furtherRepos(launchIds: readonly number[]): Promise<Map<number, string[]>> {
    const out = new Map<number, string[]>();
    if (launchIds.length === 0) return out;
    const rows = await this.#db
      .select({ launchId: launchSources.launchId, repo: launchSources.repo })
      .from(launchSources)
      .where(and(inArray(launchSources.launchId, [...launchIds]), isNotNull(launchSources.repo), ne(launchSources.role, 'primary')))
      .orderBy(asc(launchSources.launchId), asc(launchSources.position));
    for (const row of rows) out.set(row.launchId, [...(out.get(row.launchId) ?? []), row.repo!]);
    return out;
  }

  /** Records the commit a repo source was read at, so a second analysis reads the same code */
  async freeze(sourceId: number, sha: string): Promise<void> {
    await this.#db.update(launchSources).set({ sha }).where(eq(launchSources.id, sourceId));
  }

  /** Records an upload no launch owns yet; the same bytes uploaded twice are one row */
  async recordUpload(file: NewUpload): Promise<SourceMedia> {
    await this.#db
      .insert(media)
      .values({ ...file, launchId: null, role: 'upload' })
      .onConflictDoNothing();
    return (await this.upload(file.sha256))!;
  }

  /** An upload no launch owns yet, by its sha256 */
  async upload(sha256: string): Promise<SourceMedia | undefined> {
    const [row] = await this.#db
      .select()
      .from(media)
      .where(and(isNull(media.launchId), eq(media.sha256, sha256)))
      .limit(1);
    return row ? toMedia(row) : undefined;
  }

  /** The launch's own media row for an upload (the stored bytes are shared, by their key) */
  async attach(launchId: number, upload: SourceMedia): Promise<SourceMedia> {
    const { id: _id, ...file } = upload;
    await this.#db
      .insert(media)
      .values({ ...file, launchId, role: 'upload' })
      .onConflictDoNothing();
    const [row] = await this.#db
      .select()
      .from(media)
      .where(and(eq(media.launchId, launchId), eq(media.sha256, upload.sha256)))
      .limit(1);
    return toMedia(row!);
  }
}
