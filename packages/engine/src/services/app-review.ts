import { randomBytes } from 'node:crypto';
import { ContentPack, contentPackFor, draftBody, parseProjects, pieceLimitProblem, PROJECTS_PATH, Refused, withCover, type ChannelDefinition, type LaunchConfig } from '@shipcast/schema';
import { appBlogKey, appPreviewKey, channelWaits, isAppLaunch, forAppReview, previewAddress, type BlogCommit, type SitePreview } from '../app-review.ts';
import { isArticle, keepPubDates, projectSlug, type DraftFile } from '../drafts.ts';
import { GitHubError, type CommitFile, type GitHubSource, type PreviewWriter } from '../github.ts';
import { coverPath } from '../launch-assets.ts';
import { draftOfPiece, readPack, storedChannelConfig } from '../launch-import.ts';
import { draftPath } from '../launch-store.ts';
import type { MediaStore } from '../media/store.ts';
import type { Launch, Repositories, StoredApproval } from '../repositories/index.ts';
import type { Delivery, LaunchStoreService } from './launch-store.ts';

/** Why a draft was not edited or a launch not approved in the app */
export class AppReviewRefused extends Refused<'state' | 'invalid'> {}

/** The GitHub calls of a launch held by Shipcast: the site's files at publishing, and the preview on demand */
export interface AppReviewGitHub extends Pick<GitHubSource, 'fileAt'>, PreviewWriter {
  commitToBranch(repo: string, branch: string, message: string, files: CommitFile[]): Promise<{ sha: string }>;
}

export interface AppReviewDeps {
  registry: Pick<Repositories, 'launches' | 'launchStore' | 'cursors' | 'posts'>;
  media: MediaStore;
  github: AppReviewGitHub;
  /** Read at each call: the launches repo is a setting the owner can change */
  readonly launchesRepo: string;
  /** The launch model's write of the drafts as delivered, the shadow write's own (LaunchStoreService.held) */
  store: Pick<LaunchStoreService, 'held'>;
  now?: () => Date;
  /** The unguessable part of a preview branch's name; random by default */
  token?: () => string;
}

/** What publishing reads of a launch Shipcast holds: the current pack, its channels, each draft's text by its path, and what still waits */
export interface AppPublishing {
  pack: ContentPack;
  config: LaunchConfig;
  /** A draft's current version by the path it was drafted at; with `waits` empty for its channel, the approved one */
  read(path: string): Promise<string | undefined>;
  /** Why each channel may not go out yet (channelWaits) */
  waits: ReadonlyMap<string, string>;
}

/** The launches repo's branch the site deploys from, as the rest of the engine names it */
const SITE_BRANCH = 'main';

/**
 * The launch model's fifth phase (docs/app-review.md, docs/decisions/launch-model.md): with the
 * `app-review` flag a new launch has no pull request. Its drafts are rows (the launch store's), an
 * edit is a version, approving is an `approvals` row naming the versions approved, and publishing
 * reads them; the blog article and its media reach the launches repo as one commit when the launch is
 * published, and a preview on the real site is a draft pull request asked for on demand.
 */
export class AppReviewService {
  readonly #deps: AppReviewDeps;

  constructor(deps: AppReviewDeps) {
    this.#deps = deps;
  }

  get #store() {
    return this.#deps.registry.launchStore;
  }

  #now(): Date {
    return this.#deps.now?.() ?? new Date();
  }

  /**
   * The pipeline's delivery of a launch Shipcast holds: no pull request and no commit, the drafts
   * written to the launch model, which must hold all of them (a file that could not be stored throws,
   * failing the draft). Published directly, the drafts are approved as they are.
   */
  async hold(launch: Launch, delivery: Omit<Delivery, 'direct'>, options: { direct?: boolean } = {}): Promise<Launch> {
    const problems = await this.#deps.store.held(launch, { ...delivery, files: forAppReview(delivery.files) });
    if (problems.length > 0) throw new Error(`the drafts could not be stored: ${problems.join('; ')}`);
    await this.#deps.registry.launches.setModel(launch.id, 'app');
    if (options.direct) await this.#approve(launch, 'shipcast', 'published directly from the app');
    return this.#deps.registry.launches.setStatus(launch.id, 'drafted', null);
  }

  /**
   * The owner's edit of one draft: a version of their own, unless it says what the current one does.
   * Refused for a launch whose drafts are decided, a path that is not one of its drafts, a piece that
   * is out already (it is edited on its channel), or a text too long for its network.
   */
  async edit(launch: Launch, path: string, content: string, author: string | null = null): Promise<void> {
    this.#open(launch);
    const drafts = await this.#store.drafts(launch.id);
    const draft = drafts.find((d) => draftPath(d) === path);
    if (!draft) throw new AppReviewRefused('invalid', `${path} is not a draft of this launch`);
    const posts = await this.#deps.registry.posts.posts(launch.id, { channel: draft.channel as never });
    if (posts.some((p) => p.status !== 'scheduled' && draftOfPiece(p.channel, p.kind, drafts) === draft.piece)) {
      throw new AppReviewRefused('state', `${path} is out already: edit it on its channel`);
    }
    // The network would refuse it at publishing time: refused here, while it can still be fixed
    const tooLong = draft.channel === 'blog' ? undefined : pieceLimitProblem(draft.channel, draftBody(content));
    if (tooLong) throw new AppReviewRefused('invalid', `${path}: ${tooLong}`);
    const body = content.endsWith('\n') ? content : `${content}\n`;
    if (body === draft.body) return;
    await this.#store.addVersion(launch.id, { channel: draft.channel, piece: draft.piece, body, fields: { ...draft.fields, path }, origin: 'owner', author });
  }

  /** The owner approves the drafts as they are now: every draft's current version, the approval before revoked */
  async approve(launch: Launch, by = 'owner'): Promise<StoredApproval> {
    this.#open(launch);
    if (!(await this.#store.currentPack(launch.id))) throw new AppReviewRefused('state', 'this launch has no drafts to approve');
    return this.#approve(launch, by, null);
  }

  async #approve(launch: Launch, by: string, note: string | null): Promise<StoredApproval> {
    const versions = Object.fromEntries((await this.#store.drafts(launch.id)).map((d) => [String(d.id), d.versionId]));
    return this.#store.approve(launch.id, { by, versions, note });
  }

  #open(launch: Launch): void {
    if (!isAppLaunch(launch)) throw new AppReviewRefused('state', 'this launch is reviewed in its pull request');
    if (launch.status !== 'drafted') throw new AppReviewRefused('state', `the launch is ${launch.status}: its drafts are not open for review`);
  }

  /**
   * Whether anything of the launch can go out now, what a round and a draft ask before they queue its
   * publishing. The article waits for its own approval, and every channel links it, so while it waits
   * nothing goes; otherwise an approval in force, or a channel that publishes without one, is work.
   */
  async approval(launch: Launch): Promise<{ state: 'approved' } | { state: 'waiting'; reason: string }> {
    const held = await this.publishing(launch);
    if ('waiting' in held) return { state: 'waiting', reason: held.waiting };
    const blog = held.waits.get('blog');
    if (held.pack.article && held.config.publishing.blog !== 'off' && blog) return { state: 'waiting', reason: `the article ${blog}` };
    if (await this.#store.approval(launch.id)) return { state: 'approved' };
    if (Object.values(held.config.publishing).some((mode) => mode === 'auto')) return { state: 'approved' };
    return { state: 'waiting', reason: 'the drafts wait for approval in Shipcast' };
  }

  /** What publishing reads of the launch, or why it cannot read it */
  async publishing(launch: Launch, channels?: readonly ChannelDefinition[]): Promise<AppPublishing | { waiting: string }> {
    const [stored, rows, drafts, approval] = await Promise.all([this.#store.currentPack(launch.id), this.#store.channels(launch.id), this.#store.drafts(launch.id), this.#store.approval(launch.id)]);
    if (!stored) return { waiting: 'Shipcast holds no drafts for this launch' };
    const parsed = (channels ? contentPackFor(channels) : ContentPack).safeParse(readPack(stored.pack).pack);
    if (!parsed.success) return { waiting: 'the launch’s pack does not parse' };
    const config = storedChannelConfig(rows);
    if (!config) return { waiting: 'the launch’s channels cannot be read' };
    const byPath = new Map(drafts.flatMap((d) => (draftPath(d) ? [[draftPath(d)!, d.body] as const] : [])));
    return { pack: parsed.data, config, read: async (path) => byPath.get(path), waits: channelWaits({ config, drafts, approval }) };
  }

  /**
   * The site's files of the launch on the launches repo as one commit: the articles (dated today,
   * keeping the first day of one already on the site) when `article`, every file of the launch's
   * media at the address its drafts use, and a new project's cover in projects.yml. Made once: the
   * commit is recorded, and a retry answers it. A branch that moved meanwhile is tried once more on
   * its new head; any other failure throws, for the publishing to wait and try again.
   */
  async publishSite(launch: Launch, options: { article: boolean; title: string }): Promise<BlogCommit | undefined> {
    const kept = await this.#deps.registry.cursors.cursor(appBlogKey(launch.id));
    const prior = kept ? (JSON.parse(kept) as BlogCommit | { pending: { path: string; content: string } }) : undefined;
    if (prior && 'sha' in prior) return prior;
    const { launchesRepo, github } = this.#deps;
    // A run that stopped between its commit and its record left the article it was committing: on
    // main as it was, the commit was made, and it is not made twice
    if (prior && (await github.fileAt(launchesRepo, prior.pending.path, 'HEAD')) === prior.pending.content) {
      return this.#published(launch, { sha: 'found on main', at: this.#now().toISOString() });
    }
    const files = await this.#siteFiles(launch, options.article);
    if (files.length === 0) return undefined;
    const article = files.find((f): f is { path: string; content: string } => 'content' in f && f.path.startsWith('src/content/posts/'));
    if (article) await this.#deps.registry.cursors.setCursor(appBlogKey(launch.id), JSON.stringify({ pending: { path: article.path, content: article.content } }));
    const message = `publish: ${options.title}\n\nPublished by Shipcast, launch #${launch.id}.`;
    const commit = await this.#deps.github.commitToBranch(this.#deps.launchesRepo, SITE_BRANCH, message, files).catch((error: unknown) => {
      // Another commit landed between reading the head and moving it: once more, on the new head
      if (error instanceof GitHubError && (error.status === 409 || error.status === 422)) return this.#deps.github.commitToBranch(this.#deps.launchesRepo, SITE_BRANCH, message, files);
      throw error;
    });
    return this.#published(launch, { sha: commit.sha, at: this.#now().toISOString() });
  }

  async #published(launch: Launch, record: BlogCommit): Promise<BlogCommit> {
    await this.#deps.registry.cursors.setCursor(appBlogKey(launch.id), JSON.stringify(record));
    // The preview has served its purpose; a failure to close it never holds the launch back
    await this.#closePreview(launch).catch(() => undefined);
    return record;
  }

  /** The commit the launch was published with, once made */
  async published(launchId: number): Promise<BlogCommit | undefined> {
    const kept = await this.#deps.registry.cursors.cursor(appBlogKey(launchId));
    const record = kept ? (JSON.parse(kept) as Partial<BlogCommit>) : undefined;
    return record?.sha ? (record as BlogCommit) : undefined;
  }

  /** Each published piece names the version of its draft it went out with */
  async linkPublished(launch: Launch): Promise<void> {
    const [drafts, posts] = await Promise.all([this.#store.drafts(launch.id), this.#deps.registry.posts.posts(launch.id)]);
    for (const post of posts) {
      if (post.status === 'scheduled') continue;
      const piece = draftOfPiece(post.channel, post.kind, drafts);
      const draft = drafts.find((d) => d.channel === post.channel && d.piece === piece);
      if (draft) await this.#store.linkPost(post.id, draft.versionId);
    }
  }

  /**
   * A preview on the real site: the site's files as they would be published, on a preview branch of
   * the launches repo (`preview/launch-<id>-<random>`, the same one each time) with a draft pull
   * request, which the repo's workflow deploys to a `*.workers.dev` address and checks with
   * Lighthouse. Public, as everything on that repo is, but at an address nobody can guess.
   */
  async requestPreview(launch: Launch): Promise<SitePreview> {
    this.#open(launch);
    const prior = await this.sitePreview(launch.id);
    const branch = prior?.branch ?? `preview/launch-${launch.id}-${(this.#deps.token ?? (() => randomBytes(6).toString('hex')))()}`;
    const files = await this.#siteFiles(launch, true);
    if (files.length === 0) throw new AppReviewRefused('state', 'this launch has nothing for the site to show');
    const name = launch.ref.startsWith('article:') ? launch.ref.slice('article:'.length) : `${projectSlug(launch.repo)} ${launch.ref}`;
    const pushed = await this.#deps.github.pushPreview({
      repo: this.#deps.launchesRepo,
      branch,
      base: SITE_BRANCH,
      title: `Preview: ${name} (Shipcast, not for merging)`,
      body: `A preview of Shipcast's launch #${launch.id} on the real site, asked for in the app. It is closed when the launch is published; the launch is published from Shipcast, never by merging this.`,
      message: `preview: ${name}`,
      files,
    });
    const record: SitePreview = { branch, number: pushed.number, pullRequest: pushed.url, sha: pushed.sha, at: this.#now().toISOString() };
    await this.#deps.registry.cursors.setCursor(appPreviewKey(launch.id), JSON.stringify(record));
    return record;
  }

  /** The preview as last asked for, with its address once the site's workflow wrote it on the pull request */
  async findPreview(launch: Launch): Promise<SitePreview | undefined> {
    const prior = await this.sitePreview(launch.id);
    if (!prior) return undefined;
    const found = previewAddress(await this.#deps.github.pullRequestComments(this.#deps.launchesRepo, prior.number));
    if (!found) return prior;
    const next: SitePreview = { ...prior, url: found.url, ...(found.sha && { urlSha: found.sha }) };
    await this.#deps.registry.cursors.setCursor(appPreviewKey(launch.id), JSON.stringify(next));
    return next;
  }

  /** The preview as the cursor keeps it, with no GitHub call */
  async sitePreview(launchId: number): Promise<SitePreview | undefined> {
    const kept = await this.#deps.registry.cursors.cursor(appPreviewKey(launchId));
    return kept ? (JSON.parse(kept) as SitePreview) : undefined;
  }

  async #closePreview(launch: Launch): Promise<void> {
    const prior = await this.sitePreview(launch.id);
    if (!prior) return;
    await this.#deps.github.closePreview(this.#deps.launchesRepo, prior.number, prior.branch);
    await this.#deps.registry.cursors.deleteCursor(appPreviewKey(launch.id));
  }

  /** The files the site gets of the launch: its articles' current versions, its media, a new cover listed */
  async #siteFiles(launch: Launch, article: boolean): Promise<CommitFile[]> {
    const { launchesRepo, github } = this.#deps;
    const now = this.#now();
    const today = now.toISOString().slice(0, 10);
    const drafts = await this.#store.drafts(launch.id);
    // Dated the day it goes out, not the day it was drafted; one already on the site keeps its first day
    const articles: DraftFile[] = article ? drafts.filter((d) => d.channel === 'blog' && draftPath(d)).map((d) => ({ path: draftPath(d)!, content: d.body.replace(/^pubDate: \S+$/m, `pubDate: ${today}`) })) : [];
    const texts = await keepPubDates(articles, github, launchesRepo, now);

    const cover = isArticle(launch) ? undefined : coverPath(launch);
    const rows = await this.#store.media(launch.id, cover ? [cover] : []);
    const media: CommitFile[] = [];
    for (const row of rows) {
      if (row.publicPath === null) continue;
      const object = await this.#deps.media.get(row.path);
      if (!object) throw new Error(`${row.publicPath} is not in the media store`);
      media.push({ path: `public${row.publicPath}`, bytes: object.body });
    }

    const site: CommitFile[] = [];
    if (cover && rows.some((r) => r.publicPath === cover)) {
      const text = await github.fileAt(launchesRepo, PROJECTS_PATH, 'HEAD');
      const parsed = text === undefined ? undefined : parseProjects(text);
      const projects = parsed?.ok ? parsed.value : {};
      const slug = projectSlug(launch.repo);
      if (projects[slug]?.cover !== cover) site.push({ path: PROJECTS_PATH, content: withCover(text, projects, slug, cover) });
    }
    return [...texts, ...media, ...site];
  }
}
