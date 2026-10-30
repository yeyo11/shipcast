import { ContentPack, type LaunchConfig } from '@shipcast/schema';
import { readLaunchYml, readPack } from '../launch-import.ts';
import { channelsAsLaunchYml } from '../launch-store.ts';
import type { MediaObject, MediaStore } from '../media/store.ts';
import type { Launch, Repositories, StoredMediaRow } from '../repositories/index.ts';
import { reviewFromStore, type Review } from '../review.ts';

/** Where the app serves a stored file to the owner's pages: behind the session, never public */
export const launchMediaPath = (row: Pick<StoredMediaRow, 'id'>) => `/media/${row.id}`;

export interface LaunchReadDeps {
  registry: Pick<Repositories, 'launchStore'>;
  media: MediaStore;
}

/**
 * The launch model's fourth phase (docs/launch-store-read.md, docs/decisions/launch-model.md): what
 * the launch page, the REST API and MCP through it, scheduling, the comment assistant and the
 * writing assistant read of a launch, from Shipcast's own tables instead of GitHub. Built only with
 * the `launch-store-read` flag on.
 *
 * Each read takes the way it is read today (`otherwise`), used for a launch the tables do not hold:
 * one with no pack in them, drafted before the shadow write and not imported, or whose delivery the
 * shadow write could not store. A launch they hold is answered from them alone, with no GitHub call.
 */
export class LaunchReadService {
  readonly #deps: LaunchReadDeps;

  constructor(deps: LaunchReadDeps) {
    this.#deps = deps;
  }

  get #store() {
    return this.#deps.registry.launchStore;
  }

  /** The launch's drafts as the page and the REST API show them: each piece's current version, the launch's files */
  async review(launch: Launch, otherwise: () => Promise<Review | undefined>): Promise<Review | undefined> {
    const pack = await this.#store.currentPack(launch.id);
    if (!pack) return otherwise();
    const [drafts, media, channels, approval] = await Promise.all([this.#store.drafts(launch.id), this.#store.media(launch.id), this.#store.channels(launch.id), this.#store.approval(launch.id)]);
    return reviewFromStore(launch, { drafts, media, hasPack: true, channelsSource: channels.source, approved: approval !== undefined }, launchMediaPath);
  }

  /**
   * The channels the launch publishes on, as launch.yml says them: the one copied when it was drafted,
   * each channel's mode from its row (the import turned off the channels that never published).
   * Undefined when no channels were stored, as when launch.yml cannot be read.
   */
  async channelConfig(launch: Launch, otherwise: () => Promise<LaunchConfig | undefined>): Promise<LaunchConfig | undefined> {
    if (!(await this.#store.currentPack(launch.id))) return otherwise();
    const { rows, source } = await this.#store.channels(launch.id);
    if (source === null) return undefined;
    return readLaunchYml(rows.length > 0 ? channelsAsLaunchYml(source, rows) : source)?.config;
  }

  /**
   * The launch's current pack, what replies and the writing assistant are grounded in. A pack written
   * before a channel was retired is read without it, as the import reads it; undefined when even so it
   * does not parse.
   */
  async pack(launch: Launch, otherwise: () => Promise<ContentPack | undefined>): Promise<ContentPack | undefined> {
    const stored = await this.#store.currentPack(launch.id);
    if (!stored) return otherwise();
    const parsed = ContentPack.safeParse(readPack(stored.pack).pack);
    return parsed.success ? parsed.data : undefined;
  }

  /** A stored file's bytes, for the app to serve; undefined when there is no such row */
  async mediaFile(id: number): Promise<MediaObject | undefined> {
    const row = await this.#store.mediaRow(id);
    if (!row) return undefined;
    const object = await this.#deps.media.get(row.path);
    return object && { body: object.body, mime: row.mime };
  }
}
