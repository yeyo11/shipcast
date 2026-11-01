import { parseLaunchConfig, type ContentPack } from '@shipcast/schema';
import type { DraftFile } from '../drafts.ts';
import { channelRows, storedFile, mediaKind, mimeOf, type PullRequestFile } from '../launch-store.ts';
import { sha256Hex, type MediaStore } from '../media/store.ts';
import type { DraftOrigin, Launch, Repositories, StoredDraft } from '../repositories/index.ts';
import type { ReviewGitHub } from '../review.ts';

/** The cursors the check reports a launch's differences under, read by the attention list */
export const LAUNCH_STORE_PREFIX = 'launch-store:';
export const launchStoreKey = (launchId: number) => `${LAUNCH_STORE_PREFIX}${launchId}`;

/** What the check last found for a launch, as its cursor keeps it */
export interface StoreReport {
  at: string;
  differences: string[];
}

export interface LaunchStoreDeps {
  registry: Pick<Repositories, 'launchStore' | 'cursors'>;
  media: MediaStore;
  github: ReviewGitHub;
  /** Read at each call: the launches repo is a setting the owner can change */
  readonly launchesRepo: string;
  now?: () => Date;
}

/** The drafts the pipeline just handed over, with what they were made from */
export interface Delivery {
  pack: ContentPack;
  /** The launch.yml the launch publishes by, as written: the release's, or the one an article's drafts carry */
  configText: string;
  /** Every file of the drafts */
  files: readonly DraftFile[];
}

/**
 * The launch model's write (docs/launch-store.md): a launch Shipcast holds is its pack, its channel
 * rows, each draft as versions and its media in the media store (`held`), and a published article
 * edited later is a version of it too (`articleEdited`). The shadow write beside the drafts pull
 * request, and its check against it, went with the pull-request path (docs/decisions/launch-model.md,
 * phase 8). An edit that cannot be stored is reported under the launch's cursor, which the attention
 * list shows.
 */
export class LaunchStoreService {
  readonly #deps: LaunchStoreDeps;

  constructor(deps: LaunchStoreDeps) {
    this.#deps = deps;
  }

  get #store() {
    return this.#deps.registry.launchStore;
  }

  /** What the check last reported for the launch; undefined when it found nothing to report */
  async report(launchId: number): Promise<StoreReport | undefined> {
    const value = await this.#deps.registry.cursors.cursor(launchStoreKey(launchId));
    return value === undefined ? undefined : (JSON.parse(value) as StoreReport);
  }

  /**
   * A launch Shipcast holds itself (docs/app-review.md): the shadow write's own write, with no pull
   * request to compare it with and no report: what could not be stored is answered for the caller to
   * fail the draft with, since these rows are all there is of the launch.
   */
  async held(launch: Launch, delivery: Delivery): Promise<string[]> {
    const { problems } = await this.#write(launch, delivery);
    // A launch drafted again (a failed one retried) is this delivery and nothing else: a piece or a
    // file the earlier attempt made and this one did not would otherwise stay current, be reviewed,
    // approved and committed to the site. Only once everything was stored, so a failed write keeps
    // the earlier rows for the next attempt to replace
    if (problems.length === 0) await this.#retireOthers(launch, delivery.files);
    return problems;
  }

  async #retireOthers(launch: Launch, files: readonly DraftFile[]): Promise<void> {
    const pieces: Array<{ channel: string; piece: string }> = [];
    const own: string[] = [];
    for (const file of files) {
      const stored = storedFile(launch, file.path);
      if (stored.kind === 'draft') pieces.push({ channel: stored.channel, piece: stored.piece });
      else if (stored.kind === 'media' && !stored.shared && 'bytes' in file) own.push(sha256Hex(file.bytes));
    }
    await this.#store.retireDrafts(launch.id, pieces);
    const removed = await this.#store.removeMedia(launch.id, own);
    for (const row of removed) {
      // The bytes are addressed by content and may be another launch's too; a refused delete only leaves them stored
      if (!(await this.#store.mediaInUse(row.sha256))) await this.#deps.media.delete(row.path).catch(() => undefined);
    }
  }

  /** The pack, the channels, a version of each draft and every file, as the drafts were handed over */
  async #write(launch: Launch, delivery: Delivery): Promise<{ problems: string[]; files: PullRequestFile[] }> {
    const problems: string[] = [];
    const { id: packId } = await this.#store.addPack(launch.id, delivery.pack as unknown as Record<string, unknown>, { aiTask: launch.ref.startsWith('article:') ? 'article' : 'pack' });
    const config = parseLaunchConfig(delivery.configText);
    if (config.ok) await this.#store.replaceChannels(launch.id, channelRows(config.value), delivery.configText);
    else problems.push('launch.yml does not parse: no channels written');

    const current = await this.#store.drafts(launch.id);
    const files: PullRequestFile[] = [];
    const failed = new Map<string, string[]>();
    for (const file of delivery.files) {
      const stored = storedFile(launch, file.path);
      if ('content' in file) {
        files.push({ path: file.path, content: file.content });
        if (stored.kind === 'draft') await this.#version(launch.id, current, { ...stored, path: file.path, body: file.content, origin: 'ai', packId });
        continue;
      }
      const sha256 = sha256Hex(file.bytes);
      files.push({ path: file.path, content: null, sha256 });
      if (stored.kind !== 'media') continue;
      try {
        const put = await this.#deps.media.put(file.bytes, mimeOf(file.path));
        await this.#store.addMedia({
          launchId: stored.shared ? null : launch.id,
          sha256: put.sha256,
          kind: mediaKind(put.mime),
          mime: put.mime,
          bytes: put.bytes,
          storage: this.#deps.media.storage,
          path: put.key,
          role: stored.role,
          publicPath: stored.publicPath,
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        failed.set(reason, [...(failed.get(reason) ?? []), file.path]);
      }
    }
    for (const [reason, paths] of failed) problems.push(`${paths.length === 1 ? paths[0] : `${paths.length} media files`} not stored: ${reason}`);
    return { problems, files };
  }

  /**
   * A published article was edited (Edit on the launch page, committed to the launches repo's main):
   * a `post-publish-edit` version, so the copy stays what the site shows, and the article's post now
   * names that version. Reported like an edit when it cannot be stored.
   */
  articleEdited(launch: Launch, postId: number, path: string, content: string): Promise<string[]> {
    return this.#editStored(launch, path, async (stored) => {
      const versionId = await this.#version(launch.id, await this.#store.drafts(launch.id), { ...stored, path, body: content, origin: 'post-publish-edit' });
      await this.#store.linkPost(postId, versionId);
    });
  }

  async #editStored(launch: Launch, path: string, work: (stored: { channel: string; piece: string }) => Promise<void>): Promise<string[]> {
    try {
      if (!(await this.#holds(launch))) return [];
      const stored = storedFile(launch, path);
      if (stored.kind !== 'draft') return [];
      await work(stored);
      return [];
    } catch (error) {
      const problem = `${path}: the edit was not stored: ${error instanceof Error ? error.message : String(error)}`;
      const before = (await this.report(launch.id).catch(() => undefined))?.differences ?? [];
      await this.#report(launch.id, [...before, problem]).catch(() => undefined);
      return [problem];
    }
  }

  /** A launch the shadow write stored: one with a pack */
  async #holds(launch: Launch): Promise<boolean> {
    return (await this.#store.currentPack(launch.id)) !== undefined;
  }

  /** A new version of a piece's draft, unless its current one already says the same: the id of the current version either way */
  async #version(launchId: number, current: readonly StoredDraft[], input: { channel: string; piece: string; path: string; body: string; origin: DraftOrigin; author?: string | null; packId?: number }): Promise<number> {
    const draft = current.find((d) => d.channel === input.channel && d.piece === input.piece);
    if (draft && draft.body === input.body) return draft.versionId;
    const { versionId } = await this.#store.addVersion(launchId, { channel: input.channel, piece: input.piece, body: input.body, fields: { path: input.path }, origin: input.origin, author: input.author ?? null, packId: input.packId ?? null });
    return versionId;
  }

  async #report(launchId: number, differences: readonly string[]): Promise<void> {
    const key = launchStoreKey(launchId);
    if (differences.length === 0) await this.#deps.registry.cursors.deleteCursor(key);
    else await this.#deps.registry.cursors.setCursor(key, JSON.stringify({ at: (this.#deps.now?.() ?? new Date()).toISOString(), differences: [...differences] } satisfies StoreReport));
  }
}
