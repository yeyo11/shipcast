import { parseLaunchConfig, pullRequestNumber, type ContentPack } from '@shipcast/schema';
import type { DraftFile } from '../drafts.ts';
import { channelRows, storeDifferences, storedFile, mediaKind, mimeOf, type PullRequestFile, type StoreCopy } from '../launch-store.ts';
import { sha256Hex, type MediaStore } from '../media/store.ts';
import type { DraftOrigin, DraftSnapshotInput, Launch, Repositories, StoredDraft } from '../repositories/index.ts';
import { readDraftSnapshot, type ReviewGitHub } from '../review.ts';

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
  /** Every file as it was pushed: to the pull request, or committed straight onto main */
  files: readonly DraftFile[];
  /** Committed straight onto main, which approves the drafts as they are */
  direct?: { sha: string };
}

/**
 * The launch model's shadow write (docs/launch-store.md, phase 2 of docs/decisions/launch-model.md):
 * while the drafts pull request still decides everything, every launch it carries is also written to
 * Shipcast's own tables (the pack, the channel rows, each draft as versions, the media in the media
 * store, the approval at the merge) and compared with the pull request. Built only with the
 * `launch-store` flag on. The pull request still decides, so nothing here may stop today's flow: no
 * method throws, and what failed or differs is reported under the launch's cursor, which the
 * attention list shows, and answered for the caller's log.
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
   * The pipeline handed the drafts over: the pack, the channels, a version of each draft and every
   * file, then the check against what was pushed. Drafts committed straight onto main are approved.
   */
  drafted(launch: Launch, delivery: Delivery): Promise<string[]> {
    return this.#checked(launch, async () => {
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

      if (delivery.direct) await this.#approve(launch, { by: 'shipcast', note: `committed straight onto main as ${delivery.direct.sha}` });
      return [...problems, ...storeDifferences(launch, await this.#copy(launch, files), files)];
    });
  }

  /**
   * The owner edited a draft in Shipcast, which committed it to the pull request: a version of their
   * own. A failure is added to what the check last reported, which a full check replaces.
   */
  edited(launch: Launch, path: string, content: string, author: string | null = null): Promise<string[]> {
    return this.#editStored(launch, path, async (stored) => {
      await this.#version(launch.id, await this.#store.drafts(launch.id), { ...stored, path, body: content, origin: 'owner', author });
    });
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

  /**
   * The pull request was read from GitHub (the drafts snapshot's refresh, or the check at the merge):
   * each draft changed on it becomes a version of the owner's, a merge is the approval, and the rows
   * are checked against it. A launch the shadow write never stored is left alone.
   */
  async pullRequestRead(launch: Launch, read: DraftSnapshotInput): Promise<string[]> {
    if (!(await this.#holds(launch).catch(() => false))) return [];
    return this.#checked(launch, async () => {
      const current = await this.#store.drafts(launch.id);
      for (const file of read.files) {
        const stored = storedFile(launch, file.path);
        if (stored.kind !== 'draft' || file.content === null) continue;
        // A draft the rows lack is the check's to report, not this sync's to fill in
        if (current.some((d) => d.channel === stored.channel && d.piece === stored.piece)) {
          await this.#version(launch.id, current, { ...stored, path: file.path, body: file.content, origin: 'owner' });
        }
      }
      if (read.pullRequest.state === 'merged' && !(await this.#store.approval(launch.id))) {
        const pr = await this.#deps.github.pullRequest(this.#deps.launchesRepo, read.pullRequest.number);
        await this.#approve(launch, { by: pr.mergedBy ?? 'pull-request', ...(pr.mergedAt && { at: pr.mergedAt }), note: `merged ${read.pullRequest.url}` });
      }
      return storeDifferences(launch, await this.#copy(launch, read.files), read.files, read.launchYml);
    });
  }

  /**
   * The drafts were found approved, as publishing finds them before it sends anything: a merged pull
   * request is read once, for its approval and the check, whether or not the snapshot is on.
   */
  async merged(launch: Launch): Promise<string[]> {
    try {
      if (launch.detail?.startsWith('direct:') || !pullRequestNumber(launch) || !(await this.#holds(launch)) || (await this.#store.approval(launch.id))) return [];
      const read = await readDraftSnapshot(launch, { github: this.#deps.github, launchesRepo: this.#deps.launchesRepo });
      return read ? await this.pullRequestRead(launch, read) : [];
    } catch (error) {
      const problem = `the pull request could not be read for the check: ${error instanceof Error ? error.message : String(error)}`;
      await this.#report(launch.id, [problem]).catch(() => undefined);
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

  async #approve(launch: Launch, input: { by: string; at?: string; note: string }): Promise<void> {
    const versions = Object.fromEntries((await this.#store.drafts(launch.id)).map((d) => [String(d.id), d.versionId]));
    await this.#store.approveOnce(launch.id, { ...input, versions });
  }

  async #copy(launch: Launch, files: readonly PullRequestFile[]): Promise<StoreCopy> {
    const shared = files.map((f) => storedFile(launch, f.path)).flatMap((s) => (s.kind === 'media' && s.shared ? [s.publicPath] : []));
    const [pack, channels, drafts, media] = await Promise.all([this.#store.currentPack(launch.id), this.#store.channels(launch.id), this.#store.drafts(launch.id), this.#store.media(launch.id, shared)]);
    return { pack, channelsSource: channels.source, drafts, media };
  }

  /** Runs a full write or check and reports what it found, replacing the report before; a failure is reported, never thrown */
  async #checked(launch: Launch, work: () => Promise<string[]>): Promise<string[]> {
    let differences: string[];
    try {
      differences = await work();
    } catch (error) {
      differences = [`the shadow write failed: ${error instanceof Error ? error.message : String(error)}`];
    }
    await this.#report(launch.id, differences).catch(() => undefined);
    return differences;
  }

  async #report(launchId: number, differences: readonly string[]): Promise<void> {
    const key = launchStoreKey(launchId);
    if (differences.length === 0) await this.#deps.registry.cursors.deleteCursor(key);
    else await this.#deps.registry.cursors.setCursor(key, JSON.stringify({ at: (this.#deps.now?.() ?? new Date()).toISOString(), differences: [...differences] } satisfies StoreReport));
  }
}
