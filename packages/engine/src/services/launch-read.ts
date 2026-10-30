import { ContentPack, type LaunchConfig } from '@shipcast/schema';
import { appBlogKey, appPreviewKey, approvedDrafts, isAppLaunch, articlePreview, channelWaits, type ArticlePreview, type BlogCommit, type SitePreview } from '../app-review.ts';
import { readPack, storedChannelConfig } from '../launch-import.ts';
import type { MediaObject, MediaStore } from '../media/store.ts';
import { draftPath } from '../launch-store.ts';
import type { Launch, Repositories, StoredMediaRow } from '../repositories/index.ts';
import { reviewForApp, reviewFromStore, type Review } from '../review.ts';

/** Where the app serves a stored file to the owner's pages: behind the session, never public */
export const launchMediaPath = (row: Pick<StoredMediaRow, 'id'>) => `/media/${row.id}`;

export interface LaunchReadDeps {
  registry: Pick<Repositories, 'launchStore' | 'cursors'>;
  media: MediaStore;
  /** The brand's site, where an article's root-relative links point in its preview (docs/app-review.md) */
  site?: () => Promise<string>;
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
    if (isAppLaunch(launch)) return this.#appReview(launch);
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
    return storedChannelConfig(await this.#store.channels(launch.id));
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

  /**
   * A launch Shipcast holds (docs/app-review.md), which has nothing anywhere else: its drafts, which
   * of them are approved, why each channel waits, each article as the blog would show it, the preview
   * on the real site and the commit it was published with, all from the rows and cursors.
   */
  async #appReview(launch: Launch): Promise<Review> {
    const cursors = this.#deps.registry.cursors;
    const [drafts, media, channels, approval, preview, published, site] = await Promise.all([
      this.#store.drafts(launch.id),
      this.#store.media(launch.id),
      this.#store.channels(launch.id),
      this.#store.approval(launch.id),
      cursors.cursor(appPreviewKey(launch.id)),
      cursors.cursor(appBlogKey(launch.id)),
      this.#deps.site?.().catch(() => undefined),
    ]);
    const config = storedChannelConfig(channels);
    const waits = config ? channelWaits({ config, drafts, approval }) : new Map<string, string>();
    const byPublicPath = new Map(media.flatMap((row) => (row.publicPath === null ? [] : [[row.publicPath, launchMediaPath(row)] as const])));
    const previews = new Map<string, ArticlePreview>();
    for (const draft of drafts) {
      const path = draftPath(draft);
      if (draft.channel === 'blog' && path) previews.set(path, articlePreview(draft.body, { site: site ?? 'https://example.invalid', media: (p) => byPublicPath.get(p) }));
    }
    return reviewForApp(
      launch,
      {
        drafts,
        media,
        approvedPaths: approvedDrafts(drafts, approval),
        previews,
        app: {
          open: launch.status === 'drafted',
          approval: approval ? { by: approval.by, at: approval.at } : null,
          // A channel with no draft has nothing to show the owner, though it waits too
          waiting: Object.fromEntries([...waits].filter(([channel]) => drafts.some((d) => d.channel === channel))),
          preview: preview ? (JSON.parse(preview) as SitePreview) : null,
          published: published ? (JSON.parse(published) as BlogCommit) : null,
        },
      },
      launchMediaPath,
    );
  }

  /** A stored file's bytes, for the app to serve; undefined when there is no such row */
  async mediaFile(id: number): Promise<MediaObject | undefined> {
    const row = await this.#store.mediaRow(id);
    if (!row) return undefined;
    const object = await this.#deps.media.get(row.path);
    return object && { body: object.body, mime: row.mime };
  }
}
