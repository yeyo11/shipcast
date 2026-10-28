import { ConnectorError, type BrevoCampaign, type Published } from '@shipcast/connectors';
import { articleUrl as urlOf, ContentPack, lookOf, parseLaunchConfig, type Brand, type Channel, type LaunchConfig } from '@shipcast/schema';
import { parse as parseYaml } from 'yaml';
import { LAUNCH_CONFIG_PATH } from './detect.ts';
import { isArticle, launchDir, parseDiscussionDraft, parseInstagramDraft, projectLabel, projectSlug, redditDraftFile } from './drafts.ts';
import type { GitHubSource } from './github.ts';
import { carouselPieces, mediaPath, STORY_FILE } from './launch-assets.ts';
import { parseIssueDraft, renderIssueHtml } from './newsletter.ts';
import { resubmitSitemap, type MetricSources } from './metrics.ts';
import { loadProjects } from './pipeline.ts';
import type { Launch, Post, Registry } from './registry.ts';

/**
 * What the engine needs from each network's connector: the connectors in `@shipcast/connectors`
 * fit, and a test hands in fakes. A network left out is simply not published to.
 */
export interface Publishers {
  devto?: { publish(a: { title: string; markdown: string; tags: string[]; canonicalUrl: string; mainImage?: string }): Promise<Published> };
  bluesky?: {
    publish(p: {
      text: string;
      lang: string;
      link?: { url: string; title: string; description: string; thumb?: { bytes: Uint8Array; mimeType: string } };
    }): Promise<Published>;
  };
  mastodon?: {
    publish(p: {
      text: string;
      lang: string;
      image?: { bytes: Uint8Array; mimeType: string; filename: string; description: string };
      idempotencyKey: string;
    }): Promise<Published>;
  };
  instagram?: {
    publish(p: { caption: string; media: Array<{ kind: 'image' | 'video'; url: string }> }): Promise<Published>;
    publishStory?(m: { kind: 'image' | 'video'; url: string }): Promise<Published>;
    comment?(mediaId: string, message: string): Promise<{ id: string }>;
  };
  newsletter?: { subscribers(listId: number): Promise<number>; send(c: BrevoCampaign): Promise<Published> };
  hashnode?: { publish(a: { title: string; markdown: string; tags: string[]; canonicalUrl: string; coverImageUrl?: string }): Promise<Published> };
  telegram?: { publish(p: { text: string; imageUrl?: string }): Promise<Published> };
  discord?: { publish(p: { content: string; embed?: { title: string; url: string; description: string; imageUrl?: string } }): Promise<Published> };
  /** Posts in the launched repo, whichever it is, so it takes the repo with each post */
  githubDiscussions?: { publish(p: { repo: string; title: string; body: string }): Promise<Published> };
  threads?: { publish(p: { text: string; imageUrl?: string }): Promise<Published> };
  linkedin?: {
    publish(p: { text: string; article: { url: string; title: string; description: string; thumbnail?: { bytes: Uint8Array; mimeType: string } } }): Promise<Published>;
  };
  /** One post per subreddit; `find` answers whether a post whose answer was lost is up after all */
  reddit?: {
    publish(p: { subreddit: string; title: string; text: string }): Promise<Published>;
    find(p: { subreddit: string; title: string }, since: Date): Promise<Published | undefined>;
  };
}

/** Channels the engine publishes to itself; the blog is published by the merge. */
export const PUBLISHED_BY_ENGINE = ['devto', 'hashnode', 'bluesky', 'mastodon', 'instagram', 'newsletter', 'telegram', 'discord', 'githubDiscussions', 'threads', 'linkedin', 'reddit'] as const;

/** A subreddit's piece of a launch: Reddit gets one post per subreddit, as the newsletter one issue per language */
export const redditKind = (subreddit: string): `post:${string}` => `post:${subreddit.toLowerCase()}`;

/** Set before a submit and kept: a retry asks Reddit for the post first instead of submitting it again */
const redditAttemptKey = (launchId: number, subreddit: string) => `reddit-attempt:${launchId}:${subreddit.toLowerCase()}`;
type EngineChannel = (typeof PUBLISHED_BY_ENGINE)[number];

/** A cancelled scheduled piece is not published at all: the publish step skips its channel, as it skips a permanent failure */
export const cancelledKey = (launchId: number, channel: Channel) => `publish-cancelled:${launchId}:${channel}`;

/** The time a piece waits for, while it is still to come; a scheduled piece whose time has passed is due */
export function waitsUntil(post: Post, now: Date): string | undefined {
  return post.status === 'scheduled' && post.scheduledAt !== null && post.scheduledAt > now.toISOString() ? post.scheduledAt : undefined;
}

export interface PublishDeps {
  github: GitHubSource;
  registry: Registry;
  launchesRepo: string;
  publishers: Publishers;
  /** For the deployed site: whether the article is live, and the launch image's bytes */
  fetch?: typeof fetch;
  /** Search Console, to have Google read the sitemap as soon as the article is live */
  search?: MetricSources['search'];
  /** The connected account each channel publishes with, recorded on its pieces; none for `.env` credentials */
  accounts?: Partial<Record<Channel, number>>;
  /** The clock a scheduled piece is due by; the tests move it */
  now?: () => Date;
}

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
    };

/** A draft file's text as edited in the pull request: everything after its mode line. */
export function draftBody(markdown: string): string {
  const lines = markdown.split('\n');
  const mode = lines.findIndex((l) => l.startsWith('> **'));
  return lines
    .slice(mode + 1)
    .join('\n')
    .trim();
}

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

function splitFrontMatter(markdown: string): { data: Record<string, unknown>; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(markdown);
  if (!match) return { data: {}, body: markdown };
  return { data: (parseYaml(match[1]!) as Record<string, unknown>) ?? {}, body: match[2]!.trim() };
}

/**
 * The launch.yml a launch publishes by: the repo's at the release, or for an article the one its
 * drafts carry (on the launches repo's main branch once merged). Undefined when it cannot be read.
 */
export async function launchConfigOf(github: Pick<GitHubSource, 'fileAt'>, launchesRepo: string, launch: Launch): Promise<LaunchConfig | undefined> {
  // An article's channels were chosen in the app and travel with its drafts
  const configText = isArticle(launch)
    ? await github.fileAt(launchesRepo, `${launchDir(launch)}/launch.yml`, 'HEAD')
    : await github.fileAt(launch.repo, LAUNCH_CONFIG_PATH, launch.ref.startsWith('public:') ? 'HEAD' : launch.ref);
  const parsed = configText === undefined ? undefined : parseLaunchConfig(configText);
  return parsed?.ok ? parsed.value : undefined;
}

const failureKey = (launch: Launch, channel: Channel) => `publish-failed:${launch.id}:${channel}`;

/**
 * Publishes a drafted launch once its pull request is merged and the site is deployed. Every text
 * is read from the launches repo as merged, so the owner's edits in the pull request are what goes
 * out. Every piece is recorded as it goes out and published once (the registry refuses a second one
 * of the same kind); a temporary failure is retried on the next round, a permanent one is recorded
 * and not retried.
 */
export async function publishLaunch(launch: Launch, brand: Brand, deps: PublishDeps): Promise<PublishResult> {
  const { github, registry } = deps;
  const http = deps.fetch ?? globalThis.fetch;
  // Published without a pull request: the drafts went straight onto the launches repo's main branch
  const direct = launch.detail?.startsWith('direct:') ?? false;
  if (!direct) {
    const number = Number(/\/pull\/(\d+)$/.exec(launch.detail ?? '')?.[1]);
    if (!number) return { state: 'waiting', launch, reason: 'no drafts pull request recorded' };
    const state = await github.pullRequestState(deps.launchesRepo, number);
    if (state === 'open') return { state: 'waiting', launch, reason: 'the drafts pull request is open' };
    if (state === 'closed') {
      return { state: 'skipped', launch: await registry.setStatus(launch.id, 'skipped', `${launch.detail}: closed without merging`) };
    }
  }

  const dir = launchDir(launch);
  const packText = await github.fileAt(deps.launchesRepo, `${dir}/pack.json`, 'HEAD');
  if (!packText) return { state: 'waiting', launch, reason: `${dir}/pack.json is not on the default branch yet` };
  const pack = ContentPack.parse(JSON.parse(packText));
  const config = await launchConfigOf(github, deps.launchesRepo, launch);
  if (!config) return { state: 'waiting', launch, reason: `${LAUNCH_CONFIG_PATH} of ${launch.repo} cannot be read` };

  // English is the canonical version every channel links to; Spanish only where that is the only one
  const lead: 'en' | 'es' = pack.article?.en ? 'en' : 'es';
  const slug = pack.article?.[lead]?.slug;
  const articleUrl = urlOf(pack, brand.site, lead) ?? brand.site;
  // The merge starts the deploy: wait until the article (and so the media) is live
  if (slug && config.publishing.blog !== 'off') {
    const live = await http(articleUrl, { method: 'HEAD' }).then((r) => r.ok, () => false);
    if (!live) return { state: 'waiting', launch, reason: `${articleUrl} is not live yet` };
    if ((await registry.posts(launch.id, { channel: 'blog' })).length === 0 && deps.search) {
      // Not a channel: Google not hearing of the article yet never holds the launch back
      await resubmitSitemap(registry, brand.site, deps.search, new Date(), true).catch(() => false);
    }
    // One article per language, each at its own URL, so the metrics read each one's visits
    for (const lang of ['en', 'es'] as const) {
      const piece = pack.article?.[lang];
      if (!piece) continue;
      await registry.recordPost({ launchId: launch.id, channel: 'blog', kind: `article:${lang}`, url: urlOf(pack, brand.site, lang) ?? articleUrl, externalId: piece.slug });
    }
  }

  const read = (path: string) => github.fileAt(deps.launchesRepo, path, 'HEAD');
  const article = slug ? await read(`src/content/posts/${lead}/${slug}.md`) : undefined;
  const { data: front, body: articleBody } = article ? splitFrontMatter(article) : { data: {}, body: '' };
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
    const { data } = splitFrontMatter((await read(`src/content/posts/${linkedinLang}/${piece.slug}.md`)) ?? '');
    return {
      url: urlOf(pack, brand.site, linkedinLang) ?? articleUrl,
      title: typeof data.title === 'string' ? data.title : piece.title,
      description: typeof data.description === 'string' ? data.description : piece.description,
    };
  };

  const accountOf = (channel: Channel) => deps.accounts?.[channel] ?? null;
  const now = deps.now?.() ?? new Date();
  // The languages with a list and an issue in the pack: the newsletter is out once each has its issue
  const issueLanguages = (['en', 'es'] as const).filter((lang) => brand.newsletter?.lists[lang] && pack.newsletter?.[lang]);
  // Whatever account a piece went out with: a launch whose account changed since is not posted again
  const subreddits = (pack.reddit ?? []).map((r) => r.subreddit);
  const done = (pieces: Post[], channel: EngineChannel) =>
    channel === 'newsletter'
      ? issueLanguages.length > 0 && issueLanguages.every((lang) => pieces.some((p) => p.channel === channel && p.kind === `issue:${lang}`))
      : channel === 'reddit'
        ? subreddits.length > 0 && subreddits.every((sub) => pieces.some((p) => p.channel === 'reddit' && p.kind === redditKind(sub)))
        : pieces.some((p) => p.channel === channel && p.kind === 'post' && p.status !== 'scheduled');
  // A channel whose piece waits for a time still to come is neither done nor pending: it never holds the others back
  const later = (pieces: Post[], channel: EngineChannel) => pieces.map((p) => (p.channel === channel ? waitsUntil(p, now) : undefined)).find((at) => at !== undefined);
  const pieces = await registry.posts(launch.id);
  const posted: Array<{ channel: Channel; url: string }> = [];
  const problems: string[] = [];
  const scheduled: Array<{ channel: Channel; at: string }> = [];
  /** Channels whose run finished this round, though a piece may be left out (a list nobody is on yet) */
  const finished = new Set<EngineChannel>();

  // A run returns the post for the loop to record, or nothing when it recorded its pieces itself
  const publishers: Record<EngineChannel, (() => Promise<Published | undefined>) | undefined> = {
    devto:
      deps.publishers.devto && pack.devto && article
        ? async () => {
            const draft = await read(`${dir}/devto.md`);
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
            const draft = await read(`${dir}/hashnode.md`);
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
              text: draftBody((await read(`${dir}/telegram.md`)) ?? pack.telegram!.text),
              imageUrl: ogJpegUrl,
            })
        : undefined,
    discord:
      deps.publishers.discord && pack.discord
        ? async () =>
            deps.publishers.discord!.publish({
              content: draftBody((await read(`${dir}/discord.md`)) ?? pack.discord!.text),
              embed: { title, url: articleUrl, description, imageUrl: `${brand.site}${mediaPath(launch, 'og.png')}` },
            })
        : undefined,
    // An article written in the app belongs to no project: there is no repo whose community it is news to
    githubDiscussions:
      deps.publishers.githubDiscussions && pack.githubDiscussions && !isArticle(launch)
        ? async () =>
            deps.publishers.githubDiscussions!.publish({
              repo: launch.repo,
              ...parseDiscussionDraft(draftBody((await read(`${dir}/github-discussion.md`)) ?? ''), pack.githubDiscussions!),
            })
        : undefined,
    threads:
      deps.publishers.threads && pack.threads
        ? async () =>
            deps.publishers.threads!.publish({
              text: draftBody((await read(`${dir}/threads.md`)) ?? pack.threads!.text),
              imageUrl: ogJpegUrl,
            })
        : undefined,
    linkedin:
      deps.publishers.linkedin && pack.linkedin
        ? async () => {
            const card = await linkedinCard();
            return deps.publishers.linkedin!.publish({
              text: draftBody((await read(`${dir}/linkedin.md`)) ?? pack.linkedin!.text),
              // The thumbnail is uploaded to LinkedIn: it does not read the article's page
              article: { ...card, url: `${card.url}?ref=linkedin`, thumbnail: { bytes: await image(), mimeType: 'image/jpeg' } },
            });
          }
        : undefined,
    bluesky:
      deps.publishers.bluesky && pack.bluesky
        ? async () =>
            deps.publishers.bluesky!.publish({
              text: draftBody((await read(`${dir}/bluesky.md`)) ?? pack.bluesky!.text),
              lang: pack.bluesky!.lang,
              link: { url: articleUrl, title, description, thumb: { bytes: await image(), mimeType: 'image/jpeg' } },
            })
        : undefined,
    mastodon:
      deps.publishers.mastodon && pack.mastodon
        ? async () =>
            deps.publishers.mastodon!.publish({
              text: draftBody((await read(`${dir}/mastodon.md`)) ?? pack.mastodon!.text),
              // The alt text describes the launch image in the lead article's language, as the post is
              lang: pack.mastodon!.lang,
              image: { bytes: await image(), mimeType: 'image/jpeg', filename: 'og.jpg', description: `${projectLabel(pack, launch) ?? title}: ${description}` },
              idempotencyKey: `shipcast-${launch.id}-mastodon`,
            })
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
                const attempted = await registry.cursor(redditAttemptKey(launch.id, piece.subreddit));
                let result = attempted ? await reddit.find({ subreddit: piece.subreddit, title }, new Date(attempted)) : undefined;
                if (!result) {
                  await registry.setCursor(redditAttemptKey(launch.id, piece.subreddit), new Date().toISOString());
                  result = await reddit.publish({ subreddit: piece.subreddit, title, text });
                }
                await registry.recordPost({ launchId: launch.id, channel: 'reddit', kind, accountId: accountOf('reddit'), externalId: result.externalId, url: result.url });
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
            const { caption, comment } = parseInstagramDraft(draftBody((await read(`${dir}/instagram.md`)) ?? pack.instagram!.caption));
            const pieces = carouselPieces(pack, config).map((p) => ({ kind: p.kind, url: `${brand.site}${mediaPath(launch, p.file)}` }));
            const ready = [];
            for (const piece of pieces) if (await live(piece.url)) ready.push(piece);
            // A launch drafted before the carousel existed still has its launch image
            const media = ready.length > 0 ? ready : [{ kind: 'image' as const, url: ogJpegUrl }];
            const published = await ig.publish({ caption, media });
            // Recorded before the extras, so nothing that happens to them can get the post out twice
            await registry.recordPost({ launchId: launch.id, channel: 'instagram', kind: 'post', accountId: accountOf('instagram'), externalId: published.externalId, url: published.url });
            posted.push({ channel: 'instagram', url: published.url });

            // The post is out: the story and the comment are extras, reported but never worth posting it twice
            const extra = async (kind: 'story' | 'comment') => (await registry.posts(launch.id, { channel: 'instagram', kind })).length > 0;
            const storyUrl = `${brand.site}${mediaPath(launch, STORY_FILE)}`;
            if (ig.publishStory && !(await extra('story')) && (await live(storyUrl))) {
              await ig.publishStory({ kind: 'image', url: storyUrl }).then(
                (story) => registry.recordPost({ launchId: launch.id, channel: 'instagram', kind: 'story', accountId: accountOf('instagram'), externalId: story.externalId, url: story.url }),
                (error: unknown) => problems.push(`instagram story: ${error instanceof Error ? error.message : String(error)}`),
              );
            }
            if (ig.comment && comment && !(await extra('comment'))) {
              await ig.comment(published.externalId, comment).then(
                // A comment has no page of its own
                (made) => registry.recordPost({ launchId: launch.id, channel: 'instagram', kind: 'comment', accountId: accountOf('instagram'), externalId: made.id, url: null }),
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
              if ((await registry.posts(launch.id, { channel: 'newsletter', kind: `issue:${lang}` })).length > 0) {
                sent += 1;
                continue;
              }
              if ((await sender.subscribers(listId)) === 0) {
                empty.push(lang);
                continue;
              }
              const issue = parseIssueDraft(draftBody((await read(`${dir}/newsletter-${lang}.md`)) ?? ''), fromPack);
              const langSlug = pack.article?.[lang]?.slug;
              const langArticle = langSlug ? await read(`src/content/posts/${lang}/${langSlug}.md`) : undefined;
              const langTitle = langArticle ? splitFrontMatter(langArticle).data.title : undefined;
              const result = await sender.send({
                name: `${pack.project.name} ${pack.project.version ?? ''} (${lang})`.replace(/\s+/g, ' ').trim(),
                subject: issue.subject,
                previewText: issue.previewText,
                html: renderIssueHtml(issue, {
                  brand,
                  project: pack.project.name,
                  look: lookOf(projects, isArticle(launch) ? launch.ref : projectSlug(launch.repo)),
                  title: typeof langTitle === 'string' ? langTitle : title,
                  articleUrl: `${urlOf(pack, brand.site, lang) ?? articleUrl}?ref=newsletter`,
                  // No launch image: it carries the English headline, which the issue already sets on colour
                  lang,
                }),
                sender: settings.sender,
                listId,
                // No tag: Brevo's free plan refuses a campaign that carries one
              });
              // Recorded at once: the next language failing must not get this one sent twice
              await registry.recordPost({ launchId: launch.id, channel: 'newsletter', kind: `issue:${lang}`, accountId: accountOf('newsletter'), externalId: result.externalId, url: result.url });
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

  for (const channel of PUBLISHED_BY_ENGINE) {
    const mode = config.publishing[channel];
    if (mode === 'off' || done(pieces, channel)) continue;
    if ((await registry.cursor(failureKey(launch, channel))) || (await registry.cursor(cancelledKey(launch.id, channel)))) continue;
    const at = later(pieces, channel);
    if (at) {
      scheduled.push({ channel, at });
      continue;
    }
    const run = publishers[channel];
    if (!run) {
      problems.push(`${channel}: no piece in the pack or no credentials configured`);
      continue;
    }
    try {
      const result = await run();
      if (result) {
        await registry.recordPost({ launchId: launch.id, channel, kind: 'post', accountId: accountOf(channel), url: result.url, externalId: result.externalId });
        posted.push({ channel, url: result.url });
      }
      finished.add(channel);
      // What is left waiting of a finished channel (the newsletter's row, whose issues are rows of their own) goes
      await registry.clearSchedule(launch.id, channel);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryable = !(error instanceof Error && 'retryable' in error) || (error as { retryable: boolean }).retryable;
      if (!retryable) {
        await registry.setCursor(failureKey(launch, channel), message);
        // A retry of the channel is sent at once: its time has come already
        await registry.clearSchedule(launch.id, channel);
      }
      problems.push(`${channel}: ${message}${retryable ? ' (will retry)' : ''}`);
    }
  }

  const piecesNow = await registry.posts(launch.id);
  const pending: EngineChannel[] = [];
  for (const c of PUBLISHED_BY_ENGINE) {
    const mode = config.publishing[c];
    if (mode === 'off' || !publishers[c] || finished.has(c) || done(piecesNow, c) || later(piecesNow, c)) continue;
    if (!(await registry.cursor(failureKey(launch, c))) && !(await registry.cursor(cancelledKey(launch.id, c)))) pending.push(c);
  }
  if (pending.length > 0 || scheduled.length > 0) return { state: 'partial', launch: (await registry.get(launch.id))!, posted, problems, scheduled };
  return { state: 'published', launch: await registry.setStatus(launch.id, 'published', launch.detail), posted, problems, scheduled };
}
