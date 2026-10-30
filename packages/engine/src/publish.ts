import { ConnectorError, type BrevoCampaign, type Published } from '@shipcast/connectors';
import { articleLink, campaignOf, CHANNEL_DEFINITIONS, ContentPack, contentPackFor, draftBody, draftFile, IDEMPOTENT_CHANNELS, PUBLISHED_BY_ENGINE, type ChannelDefinition, type EngineChannelId, lookOf, parseFrontMatter, parseLaunchConfig, pullRequestNumber, type Brand, type Channel, type LaunchConfig, type LinkTracking } from '@shipcast/schema';
import { LAUNCH_CONFIG_PATH } from './detect.ts';
import { isArticle, launchDir, parseDiscussionDraft, parseInstagramDraft, projectLabel, projectSlug, redditDraftFile } from './drafts.ts';
import type { GitHubSource } from './github.ts';
import { carouselPieces, mediaPath, STORY_FILE } from './launch-assets.ts';
import { parseIssueDraft, renderIssueHtml } from './newsletter.ts';
import { resubmitSitemap, type MetricSources } from './metrics.ts';
import { storedChannelConfig } from './launch-import.ts';
import { loadProjects } from './pipeline.ts';
import { isRetryable, notSentBecause, type PieceGuard } from './publishing/guard.ts';
import { failureKey as failureKeyOf } from './publishing/retry.ts';

const failureKey = (launch: Launch, channel: Channel) => failureKeyOf(launch.id, channel);
import { isAppLaunch } from './app-review.ts';
import type { Launch, Post, Repositories } from './repositories/index.ts';
import type { AppReviewService } from './services/app-review.ts';
import type { LaunchStoreService } from './services/launch-store.ts';

/**
 * What the engine needs from each network's connector: the connectors in `@shipcast/connectors`
 * fit, and a test hands in fakes. A network left out is simply not published to. A channel whose
 * links are tagged (docs/tracking.md) is handed the launch's `tracking` with each piece: its adapter
 * tags the links, the connector never sees it.
 */
export interface Publishers {
  devto?: { publish(a: { title: string; markdown: string; tags: string[]; canonicalUrl: string; mainImage?: string }): Promise<Published> };
  bluesky?: {
    publish(p: {
      text: string;
      lang: string;
      link?: { url: string; title: string; description: string; thumb?: { bytes: Uint8Array; mimeType: string } };
    }, tracking?: LinkTracking): Promise<Published>;
  };
  mastodon?: {
    publish(p: {
      text: string;
      lang: string;
      image?: { bytes: Uint8Array; mimeType: string; filename: string; description: string };
      idempotencyKey: string;
    }, tracking?: LinkTracking): Promise<Published>;
  };
  instagram?: {
    publish(p: { caption: string; media: Array<{ kind: 'image' | 'video'; url: string }> }): Promise<Published>;
    publishStory?(m: { kind: 'image' | 'video'; url: string }): Promise<Published>;
    comment?(mediaId: string, message: string): Promise<{ id: string }>;
  };
  /** `tracking` names the issue's language, which its links carry */
  newsletter?: { subscribers(listId: number): Promise<number>; send(c: BrevoCampaign, tracking?: LinkTracking & { lang: 'en' | 'es' }): Promise<Published> };
  hashnode?: { publish(a: { title: string; markdown: string; tags: string[]; canonicalUrl: string; coverImageUrl?: string }): Promise<Published> };
  telegram?: { publish(p: { text: string; imageUrl?: string }, tracking?: LinkTracking): Promise<Published> };
  discord?: { publish(p: { content: string; embed?: { title: string; url: string; description: string; imageUrl?: string } }, tracking?: LinkTracking): Promise<Published> };
  /** Posts in the launched repo, whichever it is, so it takes the repo with each post */
  githubDiscussions?: { publish(p: { repo: string; title: string; body: string }, tracking?: LinkTracking): Promise<Published> };
  threads?: { publish(p: { text: string; imageUrl?: string }, tracking?: LinkTracking): Promise<Published> };
  linkedin?: {
    publish(p: { text: string; article: { url: string; title: string; description: string; thumbnail?: { bytes: Uint8Array; mimeType: string } } }, tracking?: LinkTracking): Promise<Published>;
  };
  /** One post per subreddit; `find` answers whether a post whose answer was lost is up after all */
  reddit?: {
    publish(p: { subreddit: string; title: string; text: string }, tracking?: LinkTracking): Promise<Published>;
    find(p: { subreddit: string; title: string }, since: Date): Promise<Published | undefined>;
  };
}

/** Channels the engine publishes to itself, in the registry's order; the blog is published by the merge. */
export { PUBLISHED_BY_ENGINE };

/** One channel's run: it returns the post for the loop to record, or nothing when it recorded its pieces itself */
export type PublishRun = () => Promise<Published | undefined>;

/**
 * What a channel's strategy is given to publish a launch: the launch as merged (its pack, its
 * launch.yml, the lead article's address, title and description), its media, and a way to record the
 * pieces it sends itself. The same values the built-in channels publish from.
 */
export interface PublishContext {
  launch: Launch;
  brand: Brand;
  pack: ContentPack;
  config: LaunchConfig;
  /** The launch's folder in the launches repo: its drafts and its pack */
  dir: string;
  /** A file of the launches repo's default branch, as merged */
  read(path: string): Promise<string | undefined>;
  /** The lead article's address, every channel's link */
  articleUrl: string;
  /** The site whose links are tagged and the launch's campaign, for the channel's publisher to tag its links with (docs/tracking.md) */
  tracking: LinkTracking;
  title: string;
  description: string;
  /** The public address of one of the launch's media files (`og.png`, `screenshots/home-desktop.png`) */
  mediaUrl(file: string): string;
  /** The launch image, as JPEG bytes, fetched once for every channel that uploads it */
  image(): Promise<Uint8Array>;
  /** The pieces of the launch recorded before this run */
  pieces: readonly Post[];
  github: GitHubSource;
  launchesRepo: string;
  registry: PublishDeps['registry'];
  fetch: typeof fetch;
  /** The connected account the channel publishes with; null for `.env` credentials */
  account: number | null;
  /** Records a piece the run sent, as it goes out: a later failure of the run must not send it twice */
  record(piece: { kind: Post['kind']; externalId: string; url: string | null }): Promise<Post>;
  /** Something worth saying that is not a failure of the channel */
  note(text: string): void;
}

/**
 * How one channel publishes a launch, for a channel the engine has no built-in run for: a new network
 * brings its strategy with its adapter (packages/runtime/src/channels), and the publishing loop runs it
 * as it runs the others, claimed, recorded and retried the same way.
 */
export interface PublishStrategy<P = unknown> {
  /** The run for this launch, or undefined when there is nothing of it to publish (no piece in the pack) */
  run(context: PublishContext, publisher: P): PublishRun | undefined;
  /** Whether every piece of the channel is out; by default, whether its `post` is */
  done?(pieces: readonly Post[], context: Pick<PublishContext, 'pack' | 'brand' | 'config'>): boolean;
}

/** A strategy with its channel's publisher in hand, as one run is given it */
export interface ChannelPublishing {
  run(context: PublishContext): PublishRun | undefined;
  done?(pieces: readonly Post[], context: Pick<PublishContext, 'pack' | 'brand' | 'config'>): boolean;
}

/** Binds a strategy to the publisher built for this run (the brand's account, or `.env`'s) */
export function bindStrategy<P>(strategy: PublishStrategy<P>, publisher: P): ChannelPublishing {
  return { run: (context) => strategy.run(context, publisher), ...(strategy.done && { done: strategy.done }) };
}

/** A subreddit's piece of a launch: Reddit gets one post per subreddit, as the newsletter one issue per language */
export const redditKind = (subreddit: string): `post:${string}` => `post:${subreddit.toLowerCase()}`;

/** Set before a submit and kept: a retry asks Reddit for the post first instead of submitting it again */
const redditAttemptKey = (launchId: number, subreddit: string) => `reddit-attempt:${launchId}:${subreddit.toLowerCase()}`;
type EngineChannel = EngineChannelId;

/** A cancelled scheduled piece is not published at all: the publish step skips its channel, as it skips a permanent failure */
export const cancelledKey = (launchId: number, channel: Channel) => `publish-cancelled:${launchId}:${channel}`;

/** The time a piece waits for, while it is still to come; a scheduled piece whose time has passed is due */
export function waitsUntil(post: Post, now: Date): string | undefined {
  return post.status === 'scheduled' && post.scheduledAt !== null && post.scheduledAt > now.toISOString() ? post.scheduledAt : undefined;
}

export interface PublishDeps {
  github: GitHubSource;
  /**
   * `launchStore`, when the registry has it (every real one does), is read for an imported launch's
   * channel rows; optional so the callers typed on fewer repositories need not change
   */
  registry: Pick<Repositories, 'launches' | 'posts' | 'cursors'> & Partial<Pick<Repositories, 'launchStore'>>;
  launchesRepo: string;
  publishers: Publishers;
  /**
   * The runs of the channels the engine has none built in for, by channel: their adapters' strategies
   * bound to the publishers of this run; a channel without credentials is not here
   */
  strategies?: Readonly<Record<string, ChannelPublishing>>;
  /**
   * The channels the engine publishes, in order; the registry's by default. A test hands in the
   * registry with a channel added, to show a new channel publishes from its own modules.
   */
  channels?: readonly ChannelDefinition[];
  /** For the deployed site: whether the article is live, and the launch image's bytes */
  fetch?: typeof fetch;
  /** Search Console, to have Google read the sitemap as soon as the article is live */
  search?: MetricSources['search'];
  /** The connected account each channel publishes with, recorded on its pieces; none for `.env` credentials */
  accounts?: Partial<Record<Channel, number>>;
  /** The clock a scheduled piece is due by; the tests move it */
  now?: () => Date;
  /**
   * Each channel's run claimed before it calls the network (docs/plans/performance-refactor.md,
   * phase 2): two workers publishing the same launch at once send each piece once. Without it the
   * registry's unique piece row is the only guard, and it is written after the call.
   */
  guard?: PieceGuard;
  /**
   * Keeps a launch drafted while a channel with a scheduled piece has no publisher (no credentials,
   * no piece in the pack), instead of publishing it and leaving that piece scheduled for ever: what
   * the characterisation tests found (publish.characterisation.test.ts). The publishing service's rule.
   */
  keepUnpublishable?: boolean;
  /** With `launch-store`: told once the drafts are found approved, so the merge is also an approval row (services/launch-store.ts) */
  launchStore?: Pick<LaunchStoreService, 'merged'>;
  /**
   * With `app-review`: a launch Shipcast holds is published from its approved versions, its site files
   * committed to the launches repo first (docs/app-review.md). Without it such a launch waits
   */
  appReview?: Pick<AppReviewService, 'approval' | 'publishing' | 'publishSite' | 'linkPublished'>;
}

/**
 * The channels whose run may be repeated after a worker died in it, as their definitions say
 * (`idempotent`: Mastodon takes the idempotency key, Reddit looks for its submission before
 * submitting again). Any other channel's run cut short is left `unknown` for the owner to check.
 */
export { IDEMPOTENT_CHANNELS };

export type PublishResult =
  | { state: 'waiting'; launch: Launch; reason: string }
  | { state: 'skipped'; launch: Launch }
  | {
      state: 'published' | 'partial';
      launch: Launch;
      posted: Array<{ channel: Channel; url: string }>;
      problems: string[];
      /** Channels waiting for their time: the launch stays drafted until they are out */
      scheduled: Array<{ channel: Channel; at: string }>;
      /** Each channel that failed this time, typed: what the problems say in words */
      failures: Array<{ channel: Channel; message: string; retryable: boolean }>;
      /** Channels another worker is publishing, or whose last run's outcome is unknown: left alone */
      heldElsewhere: Array<{ channel: Channel; why: string }>;
    };

/**
 * The article's Markdown with its root-relative links and images (`](/articles/x/a.png)`) on the
 * blog's address: the blog and its preview resolve them, dev.to and Hashnode do not. Code blocks are
 * left as written.
 */
export function absoluteLinks(markdown: string, site: string): string {
  const origin = new URL(site).origin;
  let fenced = false;
  return markdown
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
      return fenced ? line : line.replace(/\]\((\/(?!\/))/g, `](${origin}/`);
    })
    .join('\n');
}

/**
 * The launch.yml a launch publishes by: the repo's at the release, or for an article the one its
 * drafts carry (on the launches repo's main branch once merged). Undefined when it cannot be read.
 */
export async function launchConfigOf(github: Pick<GitHubSource, 'fileAt'>, launchesRepo: string, launch: Launch): Promise<LaunchConfig | undefined> {
  return launchConfigFrom(await launchConfigText(github, launchesRepo, launch));
}

/** The text launchConfigOf parses, which the drafts snapshot keeps so the page parses it without GitHub */
export function launchConfigText(github: Pick<GitHubSource, 'fileAt'>, launchesRepo: string, launch: Launch): Promise<string | undefined> {
  // An article's channels were chosen in the app and travel with its drafts
  return isArticle(launch)
    ? github.fileAt(launchesRepo, `${launchDir(launch)}/launch.yml`, 'HEAD')
    : github.fileAt(launch.repo, LAUNCH_CONFIG_PATH, launch.ref.startsWith('public:') ? 'HEAD' : launch.ref);
}

export function launchConfigFrom(configText: string | null | undefined): LaunchConfig | undefined {
  const parsed = configText === undefined || configText === null ? undefined : parseLaunchConfig(configText);
  return parsed?.ok ? parsed.value : undefined;
}


/**
 * Publishes a drafted launch once its pull request is merged and the site is deployed. Every text
 * is read from the launches repo as merged, so the owner's edits in the pull request are what goes
 * out. Every piece is recorded as it goes out and published once (the registry refuses a second one
 * of the same kind); a temporary failure is retried on the next round, a permanent one is recorded
 * and not retried.
 */
/**
 * Whether a drafted launch's drafts are approved: published straight onto the launches repo (`direct:`)
 * or through a pull request that was merged. What a round asks before it queues the publishing, and
 * what the publishing asks first.
 */
export async function approval(launch: Launch, deps: Pick<PublishDeps, 'github' | 'launchesRepo' | 'appReview'>): Promise<{ state: 'approved' } | { state: 'waiting'; reason: string } | { state: 'closed' }> {
  // Held by Shipcast: approved in the app, and its `auto` channels need no approval (docs/app-review.md)
  if (isAppLaunch(launch)) return deps.appReview ? deps.appReview.approval(launch) : { state: 'waiting', reason: APP_REVIEW_OFF };
  // Published without a pull request: the drafts went straight onto the launches repo's main branch
  if (launch.detail?.startsWith('direct:') ?? false) return { state: 'approved' };
  const number = pullRequestNumber(launch);
  if (!number) return { state: 'waiting', reason: 'no drafts pull request recorded' };
  const state = await deps.github.pullRequestState(deps.launchesRepo, number);
  if (state === 'open') return { state: 'waiting', reason: 'the drafts pull request is open' };
  return state === 'closed' ? { state: 'closed' } : { state: 'approved' };
}

/**
 * The channels whose run is built into publishLaunch below; any other engine channel publishes through
 * the `PublishStrategy` its adapter brings. Typed against Publishers, so the two lists cannot drift.
 */
export const BUILT_IN_PUBLISHING: Readonly<Record<keyof Publishers, true>> = {
  devto: true,
  hashnode: true,
  telegram: true,
  discord: true,
  githubDiscussions: true,
  threads: true,
  linkedin: true,
  bluesky: true,
  mastodon: true,
  reddit: true,
  instagram: true,
  newsletter: true,
};

/** Why a launch Shipcast holds does not publish in a process without the flag */
const APP_REVIEW_OFF = 'the launch is held by Shipcast and the app-review flag is off';

/** What a launch is published from: its pack, its channels and its drafts' texts by path, read as merged or as approved */
interface LaunchContent {
  pack: ContentPack;
  config: LaunchConfig;
  read: (path: string) => Promise<string | undefined>;
  /** A launch Shipcast holds: why each channel may not go out yet; none for a merged pull request */
  waits: ReadonlyMap<string, string>;
}

/** A launch reviewed in its pull request: approved by the merge, every text read from the launches repo's main */
async function mergedContent(launch: Launch, deps: PublishDeps): Promise<LaunchContent | Extract<PublishResult, { state: 'waiting' | 'skipped' }>> {
  const { github, registry } = deps;
  const approved = await approval(launch, deps);
  if (approved.state === 'waiting') return { state: 'waiting', launch, reason: approved.reason };
  if (approved.state === 'closed') return { state: 'skipped', launch: await registry.launches.setStatus(launch.id, 'skipped', `${launch.detail}: closed without merging`) };
  // It reports on its own and never throws: publishing goes on whatever the shadow write found
  await deps.launchStore?.merged(launch).catch(() => undefined);

  const dir = launchDir(launch);
  const packText = await github.fileAt(deps.launchesRepo, `${dir}/pack.json`, 'HEAD');
  if (!packText) return { state: 'waiting', launch, reason: `${dir}/pack.json is not on the default branch yet` };
  const pack = (deps.channels ? contentPackFor(deps.channels) : ContentPack).parse(JSON.parse(packText));
  // An imported launch goes by its channel rows: the import turned off the channels it never published
  // on, and launch.yml at the tag still has them on, so a round or a Try again would send them after all
  const imported = registry.launchStore && (await registry.launchStore.importedChannels(launch.id)) ? storedChannelConfig(await registry.launchStore.channels(launch.id)) : undefined;
  const config = imported ?? (await launchConfigOf(github, deps.launchesRepo, launch));
  if (!config) return { state: 'waiting', launch, reason: `${LAUNCH_CONFIG_PATH} of ${launch.repo} cannot be read` };
  return { pack, config, read: (path) => github.fileAt(deps.launchesRepo, path, 'HEAD'), waits: new Map() };
}

export async function publishLaunch(launch: Launch, brand: Brand, deps: PublishDeps): Promise<PublishResult> {
  // A launch the owner deleted sends nothing more, whatever was queued or scheduled before (docs/launch-delete.md)
  if (launch.deletedAt) return { state: 'skipped', launch };
  const { github, registry } = deps;
  const http = deps.fetch ?? globalThis.fetch;
  // A launch Shipcast holds is read from its rows, each channel cleared by its mode and the approval (docs/app-review.md)
  const app = isAppLaunch(launch) ? deps.appReview : undefined;
  if (isAppLaunch(launch) && !app) return { state: 'waiting', launch, reason: APP_REVIEW_OFF };
  const content = app ? await app.publishing(launch, deps.channels) : await mergedContent(launch, deps);
  if ('waiting' in content) return { state: 'waiting', launch, reason: content.waiting };
  if ('state' in content) return content;
  const { pack, config, read, waits } = content;
  const dir = launchDir(launch);

  // English is the canonical version every channel links to; Spanish only where that is the only one
  const lead: 'en' | 'es' = pack.article?.en ? 'en' : 'es';
  const slug = pack.article?.[lead]?.slug;
  const articleUrl = articleLink(pack, brand.site, lead);
  const channels = (deps.channels ?? CHANNEL_DEFINITIONS).filter((d) => d.publishedBy === 'engine');
  // A channel the registry of this run adds (a test's) and launch.yml cannot name yet runs in its default mode
  const modeOf = (d: ChannelDefinition) => config.publishing[d.id as Channel] ?? d.defaultMode;
  const blogOn = Boolean(slug) && config.publishing.blog !== 'off';
  if (app) {
    // Every channel links the article: while it waits for approval, nothing goes
    const blogWaits = blogOn ? waits.get('blog') : undefined;
    if (blogWaits) return { state: 'waiting', launch, reason: `the article ${blogWaits}; every channel links it` };
    // The site gets the article and the media in one commit before anything links them; a failed commit is tried again, and nothing goes out meanwhile
    if (blogOn || channels.some((d) => modeOf(d) !== 'off' && !waits.has(d.id))) {
      try {
        await app.publishSite(launch, { article: blogOn, title: pack.article?.[lead]?.title ?? pack.project.name });
      } catch (error) {
        return { state: 'waiting', launch, reason: `the article and its media could not be committed to ${deps.launchesRepo}, tried again shortly: ${error instanceof Error ? error.message : String(error)}` };
      }
      // Without the article, the media alone were committed: the channels wait until they are served
      if (!blogOn) {
        const image = `${brand.site}${mediaPath(launch, 'og.jpg')}`;
        if (!(await http(image, { method: 'HEAD' }).then((r) => r.ok, () => false))) return { state: 'waiting', launch, reason: `${image} is not live yet` };
      }
    }
  }
  // The merge (or Shipcast's commit) starts the deploy: wait until the article (and so the media) is live
  if (blogOn) {
    const live = await http(articleUrl, { method: 'HEAD' }).then((r) => r.ok, () => false);
    if (!live) return { state: 'waiting', launch, reason: `${articleUrl} is not live yet` };
    if ((await registry.posts.posts(launch.id, { channel: 'blog' })).length === 0 && deps.search) {
      // Not a channel: Google not hearing of the article yet never holds the launch back
      await resubmitSitemap(registry, brand.site, deps.search, new Date(), true).catch(() => false);
    }
    // One article per language, each at its own URL, so the metrics read each one's visits
    for (const lang of ['en', 'es'] as const) {
      const piece = pack.article?.[lang];
      if (!piece) continue;
      await registry.posts.recordPost({ launchId: launch.id, channel: 'blog', kind: `article:${lang}`, url: articleLink(pack, brand.site, lang, lead), externalId: piece.slug });
    }
  }

  const article = slug ? await read(`src/content/posts/${lead}/${slug}.md`) : undefined;
  const { data: front, body: articleBody } = article ? parseFrontMatter(article) : { data: {}, body: '' };
  const title = typeof front.title === 'string' ? front.title : pack.article?.en?.title ?? pack.project.name;
  const description = typeof front.description === 'string' ? front.description : pack.article?.en?.description ?? pack.analysis.summary;
  const ogJpegUrl = `${brand.site}${mediaPath(launch, 'og.jpg')}`;
  let ogJpeg: Uint8Array | undefined;
  const image = async () => {
    if (!ogJpeg) {
      const response = await http(ogJpegUrl);
      if (!response.ok) throw new Error(`${ogJpegUrl} answered ${response.status}`);
      ogJpeg = new Uint8Array(await response.arrayBuffer());
    }
    return ogJpeg;
  };

  // LinkedIn speaks the brand's language for it (`languages.linkedin`), and its card shares that
  // language's article, read as merged like the lead one; without it, or without that article, the lead
  const linkedinLang = brand.languages.linkedin && pack.article?.[brand.languages.linkedin] ? brand.languages.linkedin : lead;
  const linkedinCard = async () => {
    if (linkedinLang === lead) return { url: articleUrl, title, description };
    const piece = pack.article![linkedinLang]!;
    const { data } = parseFrontMatter((await read(`src/content/posts/${linkedinLang}/${piece.slug}.md`)) ?? '');
    return {
      url: articleLink(pack, brand.site, linkedinLang, lead),
      title: typeof data.title === 'string' ? data.title : piece.title,
      description: typeof data.description === 'string' ? data.description : piece.description,
    };
  };

  // Every link to the site carries the network and the launch it came from; the adapters tag them
  const tracking: LinkTracking = { site: brand.site, campaign: campaignOf(launch) };
  const accountOf = (channel: Channel) => deps.accounts?.[channel] ?? null;
  const now = deps.now?.() ?? new Date();
  // The languages with a list and an issue in the pack: the newsletter is out once each has its issue
  const issueLanguages = (['en', 'es'] as const).filter((lang) => brand.newsletter?.lists[lang] && pack.newsletter?.[lang]);
  // Whatever account a piece went out with: a launch whose account changed since is not posted again
  const subreddits = (pack.reddit ?? []).map((r) => r.subreddit);
  const builtInDone = (pieces: readonly Post[], channel: string) =>
    channel === 'newsletter'
      ? issueLanguages.length > 0 && issueLanguages.every((lang) => pieces.some((p) => p.channel === channel && p.kind === `issue:${lang}`))
      : channel === 'reddit'
        ? subreddits.length > 0 && subreddits.every((sub) => pieces.some((p) => p.channel === 'reddit' && p.kind === redditKind(sub)))
        : pieces.some((p) => p.channel === channel && p.kind === 'post' && p.status !== 'scheduled');
  // A channel whose piece waits for a time still to come is neither done nor pending: it never holds the others back
  const later = (pieces: readonly Post[], channel: string) => pieces.map((p) => (p.channel === channel ? waitsUntil(p, now) : undefined)).find((at) => at !== undefined);
  const pieces = await registry.posts.posts(launch.id);
  const posted: Array<{ channel: Channel; url: string }> = [];
  const problems: string[] = [];
  const scheduled: Array<{ channel: Channel; at: string }> = [];
  const failures: Array<{ channel: Channel; message: string; retryable: boolean }> = [];
  const heldElsewhere: Array<{ channel: Channel; why: string }> = [];
  /** Channels whose run finished this round, though a piece may be left out (a list nobody is on yet) */
  const finished = new Set<string>();

  /** What a channel's strategy publishes from: the same values the built-in runs below use */
  const contextFor = (channel: Channel): PublishContext => ({
    launch,
    brand,
    pack,
    config,
    dir,
    read,
    articleUrl,
    tracking,
    title,
    description,
    mediaUrl: (file) => `${brand.site}${mediaPath(launch, file)}`,
    image,
    pieces,
    github,
    launchesRepo: deps.launchesRepo,
    registry,
    fetch: http,
    account: accountOf(channel),
    record: async (piece) => {
      const { post } = await registry.posts.recordPost({ launchId: launch.id, channel, kind: piece.kind, accountId: accountOf(channel), externalId: piece.externalId, url: piece.url });
      if (piece.url) posted.push({ channel, url: piece.url });
      return post;
    },
    note: (text) => problems.push(`${channel}: ${text}`),
  });
  const strategies = deps.strategies ?? {};
  const strategyOf = (channel: string): ChannelPublishing | undefined => (channel in BUILT_IN_PUBLISHING ? undefined : strategies[channel]);
  const done = (pieces: readonly Post[], channel: string) => strategyOf(channel)?.done?.(pieces, { pack, brand, config }) ?? builtInDone(pieces, channel);

  // A run returns the post for the loop to record, or nothing when it recorded its pieces itself
  const builtIn: Record<keyof typeof BUILT_IN_PUBLISHING, PublishRun | undefined> = {
    devto:
      deps.publishers.devto && pack.devto && article
        ? async () => {
            const draft = await read(`${dir}/${draftFile('devto').name}`);
            const tags = /Tags: (.+)$/m.exec(draft ?? '')?.[1]?.match(/`([^`]+)`/g)?.map((t) => t.slice(1, -1)) ?? pack.devto!.tags;
            return deps.publishers.devto!.publish({
              title,
              markdown: absoluteLinks(articleBody, brand.site),
              tags,
              canonicalUrl: articleUrl,
              mainImage: `${brand.site}${mediaPath(launch, 'og.png')}`,
            });
          }
        : undefined,
    hashnode:
      deps.publishers.hashnode && pack.hashnode && article
        ? async () => {
            const draft = await read(`${dir}/${draftFile('hashnode').name}`);
            const tags = /Tags: (.+)$/m.exec(draft ?? '')?.[1]?.match(/`([^`]+)`/g)?.map((t) => t.slice(1, -1)) ?? pack.hashnode!.tags;
            return deps.publishers.hashnode!.publish({
              title,
              markdown: absoluteLinks(articleBody, brand.site),
              tags,
              canonicalUrl: articleUrl,
              coverImageUrl: `${brand.site}${mediaPath(launch, 'og.png')}`,
            });
          }
        : undefined,
    telegram:
      deps.publishers.telegram && pack.telegram
        ? async () =>
            deps.publishers.telegram!.publish({
              text: draftBody((await read(`${dir}/${draftFile('telegram').name}`)) ?? pack.telegram!.text),
              imageUrl: ogJpegUrl,
            }, tracking)
        : undefined,
    discord:
      deps.publishers.discord && pack.discord
        ? async () =>
            deps.publishers.discord!.publish({
              content: draftBody((await read(`${dir}/${draftFile('discord').name}`)) ?? pack.discord!.text),
              embed: { title, url: articleUrl, description, imageUrl: `${brand.site}${mediaPath(launch, 'og.png')}` },
            }, tracking)
        : undefined,
    // An article written in the app belongs to no project: there is no repo whose community it is news to
    githubDiscussions:
      deps.publishers.githubDiscussions && pack.githubDiscussions && !isArticle(launch)
        ? async () =>
            deps.publishers.githubDiscussions!.publish({
              repo: launch.repo,
              ...parseDiscussionDraft(draftBody((await read(`${dir}/${draftFile('githubDiscussions').name}`)) ?? ''), pack.githubDiscussions!),
            }, tracking)
        : undefined,
    threads:
      deps.publishers.threads && pack.threads
        ? async () =>
            deps.publishers.threads!.publish({
              text: draftBody((await read(`${dir}/${draftFile('threads').name}`)) ?? pack.threads!.text),
              imageUrl: ogJpegUrl,
            }, tracking)
        : undefined,
    linkedin:
      deps.publishers.linkedin && pack.linkedin
        ? async () => {
            const card = await linkedinCard();
            return deps.publishers.linkedin!.publish({
              text: draftBody((await read(`${dir}/${draftFile('linkedin').name}`)) ?? pack.linkedin!.text),
              // The thumbnail is uploaded to LinkedIn: it does not read the article's page
              article: { ...card, url: `${card.url}?ref=linkedin`, thumbnail: { bytes: await image(), mimeType: 'image/jpeg' } },
            }, tracking);
          }
        : undefined,
    bluesky:
      deps.publishers.bluesky && pack.bluesky
        ? async () =>
            deps.publishers.bluesky!.publish({
              text: draftBody((await read(`${dir}/${draftFile('bluesky').name}`)) ?? pack.bluesky!.text),
              lang: pack.bluesky!.lang,
              link: { url: articleUrl, title, description, thumb: { bytes: await image(), mimeType: 'image/jpeg' } },
            }, tracking)
        : undefined,
    mastodon:
      deps.publishers.mastodon && pack.mastodon
        ? async () =>
            deps.publishers.mastodon!.publish({
              text: draftBody((await read(`${dir}/${draftFile('mastodon').name}`)) ?? pack.mastodon!.text),
              // The alt text describes the launch image in the lead article's language, as the post is
              lang: pack.mastodon!.lang,
              image: { bytes: await image(), mimeType: 'image/jpeg', filename: 'og.jpg', description: `${projectLabel(pack, launch) ?? title}: ${description}` },
              idempotencyKey: `shipcast-${launch.id}-mastodon`,
            }, tracking)
        : undefined,
    // One post per subreddit, each recorded as it goes out; a refusal in one never holds back the others
    reddit:
      deps.publishers.reddit && pack.reddit
        ? async () => {
            const reddit = deps.publishers.reddit!;
            const failures: ConnectorError[] = [];
            for (const piece of pack.reddit!) {
              const kind = redditKind(piece.subreddit);
              if (pieces.some((p) => p.channel === 'reddit' && p.kind === kind)) continue;
              const { title, body } = parseDiscussionDraft(draftBody((await read(`${dir}/${redditDraftFile(piece.subreddit)}`)) ?? ''), piece);
              const link = `${articleUrl}?ref=reddit`;
              const text = body.includes(articleUrl) ? body : `${body}\n\n${link}`;
              try {
                // A submit whose answer was lost may be up: look for it before submitting again
                const attempted = await registry.cursors.cursor(redditAttemptKey(launch.id, piece.subreddit));
                let result = attempted ? await reddit.find({ subreddit: piece.subreddit, title }, new Date(attempted)) : undefined;
                if (!result) {
                  await registry.cursors.setCursor(redditAttemptKey(launch.id, piece.subreddit), new Date().toISOString());
                  result = await reddit.publish({ subreddit: piece.subreddit, title, text }, tracking);
                }
                await registry.posts.recordPost({ launchId: launch.id, channel: 'reddit', kind, accountId: accountOf('reddit'), externalId: result.externalId, url: result.url });
                posted.push({ channel: 'reddit', url: result.url });
              } catch (error) {
                failures.push(error instanceof ConnectorError ? error : new ConnectorError('Reddit', error instanceof Error ? error.message : String(error)));
              }
            }
            if (failures.length > 0) {
              // Tried again only when every failure can be: a refused subreddit waits for Try again
              throw new ConnectorError('Reddit', failures.map((f) => f.message.replace(/^Reddit: /, '')).join('; '), undefined, failures.every((f) => f.retryable));
            }
            return undefined;
          }
        : undefined,
    instagram:
      deps.publishers.instagram && pack.instagram
        ? async () => {
            const ig = deps.publishers.instagram!;
            const live = (url: string) => http(url, { method: 'HEAD' }).then((r) => r.ok, () => false);
            const { caption, comment } = parseInstagramDraft(draftBody((await read(`${dir}/${draftFile('instagram').name}`)) ?? pack.instagram!.caption));
            const pieces = carouselPieces(pack, config).map((p) => ({ kind: p.kind, url: `${brand.site}${mediaPath(launch, p.file)}` }));
            const ready = [];
            for (const piece of pieces) if (await live(piece.url)) ready.push(piece);
            // A launch drafted before the carousel existed still has its launch image
            const media = ready.length > 0 ? ready : [{ kind: 'image' as const, url: ogJpegUrl }];
            const published = await ig.publish({ caption, media });
            // Recorded before the extras, so nothing that happens to them can get the post out twice
            await registry.posts.recordPost({ launchId: launch.id, channel: 'instagram', kind: 'post', accountId: accountOf('instagram'), externalId: published.externalId, url: published.url });
            posted.push({ channel: 'instagram', url: published.url });

            // The post is out: the story and the comment are extras, reported but never worth posting it twice
            const extra = async (kind: 'story' | 'comment') => (await registry.posts.posts(launch.id, { channel: 'instagram', kind })).length > 0;
            const storyUrl = `${brand.site}${mediaPath(launch, STORY_FILE)}`;
            if (ig.publishStory && !(await extra('story')) && (await live(storyUrl))) {
              await ig.publishStory({ kind: 'image', url: storyUrl }).then(
                (story) => registry.posts.recordPost({ launchId: launch.id, channel: 'instagram', kind: 'story', accountId: accountOf('instagram'), externalId: story.externalId, url: story.url }),
                (error: unknown) => problems.push(`instagram story: ${error instanceof Error ? error.message : String(error)}`),
              );
            }
            if (ig.comment && comment && !(await extra('comment'))) {
              await ig.comment(published.externalId, comment).then(
                // A comment has no page of its own
                (made) => registry.posts.recordPost({ launchId: launch.id, channel: 'instagram', kind: 'comment', accountId: accountOf('instagram'), externalId: made.id, url: null }),
                (error: unknown) => problems.push(`instagram comment: ${error instanceof Error ? error.message : String(error)}`),
              );
            }
            return undefined;
          }
        : undefined,
    newsletter:
      deps.publishers.newsletter && pack.newsletter && brand.newsletter
        ? async () => {
            const sender = deps.publishers.newsletter!;
            const settings = brand.newsletter!;
            let sent = 0;
            const empty: string[] = [];
            const projects = await loadProjects(github, deps.launchesRepo);
            for (const lang of ['en', 'es'] as const) {
              const listId = settings.lists[lang];
              const fromPack = pack.newsletter![lang];
              if (!listId || !fromPack) continue;
              // One campaign per language: an issue already out is never sent again, even if the other one failed
              if ((await registry.posts.posts(launch.id, { channel: 'newsletter', kind: `issue:${lang}` })).length > 0) {
                sent += 1;
                continue;
              }
              if ((await sender.subscribers(listId)) === 0) {
                empty.push(lang);
                continue;
              }
              const issue = parseIssueDraft(draftBody((await read(`${dir}/${draftFile('newsletter', lang).name}`)) ?? ''), fromPack);
              const langSlug = pack.article?.[lang]?.slug;
              const langArticle = langSlug ? await read(`src/content/posts/${lang}/${langSlug}.md`) : undefined;
              const langTitle = langArticle ? parseFrontMatter(langArticle).data.title : undefined;
              const result = await sender.send({
                name: `${pack.project.name} ${pack.project.version ?? ''} (${lang})`.replace(/\s+/g, ' ').trim(),
                subject: issue.subject,
                previewText: issue.previewText,
                html: renderIssueHtml(issue, {
                  brand,
                  project: pack.project.name,
                  look: lookOf(projects, isArticle(launch) ? launch.ref : projectSlug(launch.repo)),
                  title: typeof langTitle === 'string' ? langTitle : title,
                  articleUrl: `${articleLink(pack, brand.site, lang, lead)}?ref=newsletter`,
                  // No launch image: it carries the English headline, which the issue already sets on colour
                  lang,
                }),
                sender: settings.sender,
                listId,
                // No tag: Brevo's free plan refuses a campaign that carries one
              }, { ...tracking, lang });
              // Recorded at once: the next language failing must not get this one sent twice
              await registry.posts.recordPost({ launchId: launch.id, channel: 'newsletter', kind: `issue:${lang}`, accountId: accountOf('newsletter'), externalId: result.externalId, url: result.url });
              posted.push({ channel: 'newsletter', url: result.url });
              sent += 1;
            }
            if (sent === 0) {
              // Nobody to write to yet is not worth retrying every round; the next launch will have readers
              throw new ConnectorError('Brevo', `no subscribers yet in the ${empty.join(' and ')} list`, undefined, false);
            }
            return undefined;
          }
        : undefined,
  };

  const runs = new Map<string, PublishRun | undefined>();
  for (const d of channels) {
    const own = strategyOf(d.id);
    runs.set(d.id, own ? own.run(contextFor(d.id as Channel)) : builtIn[d.id as keyof typeof BUILT_IN_PUBLISHING]);
  }

  // Read again before each send: the owner may delete the launch while this run is under way (a
  // removed launch has no row any more), and nothing more of it may go out from then on
  const deleted = async () => {
    const now = await registry.launches.get(launch.id);
    return !now || now.deletedAt !== undefined;
  };
  for (const definition of channels) {
    const channel = definition.id as EngineChannel;
    const mode = modeOf(definition);
    if (mode === 'off' || done(pieces, channel)) continue;
    // Held by Shipcast and not approved (or edited since): pending until it is
    if (waits.has(channel)) continue;
    if ((await registry.cursors.cursor(failureKey(launch, channel))) || (await registry.cursors.cursor(cancelledKey(launch.id, channel)))) continue;
    const at = later(pieces, channel);
    if (at) {
      scheduled.push({ channel, at });
      continue;
    }
    const run = runs.get(channel);
    if (!run) {
      problems.push(`${channel}: no piece in the pack or no credentials configured`);
      continue;
    }
    if (await deleted()) return { state: 'skipped', launch };
    try {
      // Claimed for this run, then checked again: a worker that read the pieces before another's went out sends nothing
      const guarded = deps.guard
        ? await deps.guard.run({ launchId: launch.id, channel, kind: 'post' }, { idempotent: IDEMPOTENT_CHANNELS.has(channel), reclaimLive: true, stillNeeded: async () => !(await deleted()) && !done(await registry.posts.posts(launch.id), channel) && !(await registry.cursors.cursor(failureKey(launch, channel))) }, run)
        : { ran: true as const, value: await run() };
      if (!guarded.ran) {
        if (guarded.attempt.state !== 'live') heldElsewhere.push({ channel, why: notSentBecause(guarded.attempt) });
        continue;
      }
      const result = guarded.value;
      if (result) {
        await registry.posts.recordPost({ launchId: launch.id, channel, kind: 'post', accountId: accountOf(channel), url: result.url, externalId: result.externalId });
        posted.push({ channel, url: result.url });
      }
      finished.add(channel);
      // What is left waiting of a finished channel (the newsletter's row, whose issues are rows of their own) goes
      await registry.posts.clearSchedule(launch.id, channel);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryable = isRetryable(error);
      failures.push({ channel, message, retryable });
      if (!retryable) {
        await registry.cursors.setCursor(failureKey(launch, channel), message);
        // A retry of the channel is sent at once: its time has come already
        await registry.posts.clearSchedule(launch.id, channel);
      }
      problems.push(`${channel}: ${message}${retryable ? ' (will retry)' : ''}`);
    }
  }

  // What each piece went out with, for a launch Shipcast holds; never worth failing the run for
  await app?.linkPublished(launch).catch(() => undefined);
  const piecesNow = await registry.posts.posts(launch.id);
  const pending: string[] = [];
  for (const definition of channels) {
    const c = definition.id as EngineChannel;
    const mode = modeOf(definition);
    // A channel with nothing to publish it is not pending, unless the publishing service keeps it: a
    // piece of it is scheduled, and publishing the launch would leave that piece waiting for ever
    const unpublishable = !runs.get(c) && !(deps.keepUnpublishable && piecesNow.some((p) => p.channel === c && p.status === 'scheduled'));
    if (mode === 'off' || unpublishable || finished.has(c) || done(piecesNow, c) || later(piecesNow, c)) continue;
    if (!(await registry.cursors.cursor(failureKey(launch, c))) && !(await registry.cursors.cursor(cancelledKey(launch.id, c)))) pending.push(c);
  }
  if (pending.length > 0 || scheduled.length > 0) return { state: 'partial', launch: (await registry.launches.get(launch.id))!, posted, problems, scheduled, failures, heldElsewhere };
  return { state: 'published', launch: await registry.launches.setStatus(launch.id, 'published', launch.detail), posted, problems, scheduled, failures, heldElsewhere };
}
