import { ConnectorError, type BrevoCampaign, type Published } from '@shipcast/connectors';
import { articleUrl as urlOf, ContentPack, parseLaunchConfig, type Brand, type Channel, type LaunchConfig } from '@shipcast/schema';
import { parse as parseYaml } from 'yaml';
import { LAUNCH_CONFIG_PATH } from './detect.ts';
import { launchDir, parseInstagramDraft } from './drafts.ts';
import type { GitHubSource } from './github.ts';
import { carouselPieces, mediaPath, STORY_FILE } from './launch-assets.ts';
import { parseIssueDraft, renderIssueHtml } from './newsletter.ts';
import type { Launch, Registry } from './registry.ts';

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
}

/** Channels the engine publishes to itself; the blog is published by the merge, Reddit by hand. */
const PUBLISHED_BY_ENGINE = ['devto', 'bluesky', 'mastodon', 'instagram', 'newsletter'] as const;
type EngineChannel = (typeof PUBLISHED_BY_ENGINE)[number];

export interface PublishDeps {
  github: GitHubSource;
  registry: Registry;
  launchesRepo: string;
  publishers: Publishers;
  /** For the deployed site: whether the article is live, and the launch image's bytes */
  fetch?: typeof fetch;
}

export type PublishResult =
  | { state: 'waiting'; launch: Launch; reason: string }
  | { state: 'skipped'; launch: Launch }
  | { state: 'published' | 'partial'; launch: Launch; posted: Array<{ channel: Channel; url: string }>; problems: string[] };

/** A draft file's text as edited in the pull request: everything after its mode line. */
export function draftBody(markdown: string): string {
  const lines = markdown.split('\n');
  const mode = lines.findIndex((l) => l.startsWith('> **'));
  return lines
    .slice(mode + 1)
    .join('\n')
    .trim();
}

function splitFrontMatter(markdown: string): { data: Record<string, unknown>; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(markdown);
  if (!match) return { data: {}, body: markdown };
  return { data: (parseYaml(match[1]!) as Record<string, unknown>) ?? {}, body: match[2]!.trim() };
}

const failureKey = (launch: Launch, channel: Channel) => `publish-failed:${launch.id}:${channel}`;
/** The story and the comment that follow an Instagram post, each done once */
const extraKey = (launch: Launch, what: 'story' | 'comment') => `instagram-${what}:${launch.id}`;
/** One campaign per language: each language is sent once, even if another one fails and is retried */
const issueKey = (launch: Launch, lang: string) => `newsletter-sent:${launch.id}:${lang}`;

/**
 * Publishes a drafted launch once its pull request is merged and the site is deployed. Every text
 * is read from the launches repo as merged, so the owner's edits in the pull request are what goes
 * out. Each channel is published once (the registry refuses a second post); a temporary failure is
 * retried on the next round, a permanent one is recorded and not retried.
 */
export async function publishLaunch(launch: Launch, brand: Brand, deps: PublishDeps): Promise<PublishResult> {
  const { github, registry } = deps;
  const http = deps.fetch ?? globalThis.fetch;
  const number = Number(/\/pull\/(\d+)$/.exec(launch.detail ?? '')?.[1]);
  if (!number) return { state: 'waiting', launch, reason: 'no drafts pull request recorded' };

  const state = await github.pullRequestState(deps.launchesRepo, number);
  if (state === 'open') return { state: 'waiting', launch, reason: 'the drafts pull request is open' };
  if (state === 'closed') {
    return { state: 'skipped', launch: registry.setStatus(launch.id, 'skipped', `${launch.detail}: closed without merging`) };
  }

  const dir = launchDir(launch);
  const packText = await github.fileAt(deps.launchesRepo, `${dir}/pack.json`, 'HEAD');
  if (!packText) return { state: 'waiting', launch, reason: `${dir}/pack.json is not on the default branch yet` };
  const pack = ContentPack.parse(JSON.parse(packText));
  const configText = await github.fileAt(launch.repo, LAUNCH_CONFIG_PATH, launch.ref.startsWith('public:') ? 'HEAD' : launch.ref);
  const parsed = configText === undefined ? undefined : parseLaunchConfig(configText);
  if (!parsed?.ok) return { state: 'waiting', launch, reason: `${LAUNCH_CONFIG_PATH} of ${launch.repo} cannot be read` };
  const config: LaunchConfig = parsed.value;

  // English is the canonical version every channel links to; Spanish only where that is the only one
  const lead: 'en' | 'es' = pack.article?.en ? 'en' : 'es';
  const slug = pack.article?.[lead]?.slug;
  const articleUrl = urlOf(pack, brand.site, lead) ?? brand.site;
  // The merge starts the deploy: wait until the article (and so the media) is live
  if (slug && config.publishing.blog !== 'off') {
    const live = await http(articleUrl, { method: 'HEAD' }).then((r) => r.ok, () => false);
    if (!live) return { state: 'waiting', launch, reason: `${articleUrl} is not live yet` };
    // Both languages' slugs, so the metrics can read each article's visits
    const slugs = (['en', 'es'] as const).filter((l) => pack.article?.[l]).map((l) => `${l}:${pack.article![l]!.slug}`).join(',');
    registry.recordPost({ launchId: launch.id, channel: 'blog', url: articleUrl, externalId: slugs });
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

  const already = new Set(registry.posts(launch.id).map((p) => p.channel));
  const posted: Array<{ channel: Channel; url: string }> = [];
  const problems: string[] = [];

  const publishers: Record<EngineChannel, (() => Promise<Published>) | undefined> = {
    devto:
      deps.publishers.devto && pack.devto && article
        ? async () => {
            const draft = await read(`${dir}/devto.md`);
            const tags = /Tags: (.+)$/m.exec(draft ?? '')?.[1]?.match(/`([^`]+)`/g)?.map((t) => t.slice(1, -1)) ?? pack.devto!.tags;
            return deps.publishers.devto!.publish({
              title,
              markdown: articleBody,
              tags,
              canonicalUrl: articleUrl,
              mainImage: `${brand.site}${mediaPath(launch, 'og.png')}`,
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
              lang: pack.mastodon!.lang,
              image: { bytes: await image(), mimeType: 'image/jpeg', filename: 'og.jpg', description: `${pack.project.name}: ${description}` },
              idempotencyKey: `shipcast-${launch.id}-mastodon`,
            })
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

            // The post is out: the story and the comment are extras, reported but never worth posting it twice
            const storyUrl = `${brand.site}${mediaPath(launch, STORY_FILE)}`;
            if (ig.publishStory && !registry.cursor(extraKey(launch, 'story')) && (await live(storyUrl))) {
              await ig.publishStory({ kind: 'image', url: storyUrl }).then(
                (story) => registry.setCursor(extraKey(launch, 'story'), story.externalId),
                (error: unknown) => problems.push(`instagram story: ${error instanceof Error ? error.message : String(error)}`),
              );
            }
            if (ig.comment && comment && !registry.cursor(extraKey(launch, 'comment'))) {
              await ig.comment(published.externalId, comment).then(
                (made) => registry.setCursor(extraKey(launch, 'comment'), made.id),
                (error: unknown) => problems.push(`instagram comment: ${error instanceof Error ? error.message : String(error)}`),
              );
            }
            return published;
          }
        : undefined,
    newsletter:
      deps.publishers.newsletter && pack.newsletter && brand.newsletter
        ? async () => {
            const sender = deps.publishers.newsletter!;
            const settings = brand.newsletter!;
            const sent: Published[] = [];
            const empty: string[] = [];
            for (const lang of ['en', 'es'] as const) {
              const listId = settings.lists[lang];
              const fromPack = pack.newsletter![lang];
              if (!listId || !fromPack) continue;
              const done = registry.cursor(issueKey(launch, lang));
              if (done) {
                sent.push(JSON.parse(done) as Published);
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
                  title: typeof langTitle === 'string' ? langTitle : title,
                  articleUrl: `${urlOf(pack, brand.site, lang) ?? articleUrl}?ref=newsletter`,
                  // No launch image: it carries the English headline, which the issue already sets on colour
                  lang,
                }),
                sender: settings.sender,
                listId,
                // No tag: Brevo's free plan refuses a campaign that carries one
              });
              registry.setCursor(issueKey(launch, lang), JSON.stringify(result));
              sent.push(result);
            }
            if (sent.length === 0) {
              // Nobody to write to yet is not worth retrying every round; the next launch will have readers
              throw new ConnectorError('Brevo', `no subscribers yet in the ${empty.join(' and ')} list`, undefined, false);
            }
            return { externalId: sent.map((p) => p.externalId).join(','), url: sent[0]!.url };
          }
        : undefined,
  };

  for (const channel of PUBLISHED_BY_ENGINE) {
    const mode = config.publishing[channel];
    if (mode === 'off' || mode === 'manual' || already.has(channel)) continue;
    if (registry.cursor(failureKey(launch, channel))) continue;
    const run = publishers[channel];
    if (!run) {
      problems.push(`${channel}: no piece in the pack or no credentials configured`);
      continue;
    }
    try {
      const result = await run();
      registry.recordPost({ launchId: launch.id, channel, url: result.url, externalId: result.externalId });
      posted.push({ channel, url: result.url });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryable = !(error instanceof Error && 'retryable' in error) || (error as { retryable: boolean }).retryable;
      if (!retryable) registry.setCursor(failureKey(launch, channel), message);
      problems.push(`${channel}: ${message}${retryable ? ' (will retry)' : ''}`);
    }
  }

  const pending = PUBLISHED_BY_ENGINE.filter((c) => {
    const mode = config.publishing[c];
    return mode !== 'off' && mode !== 'manual' && publishers[c] && !registry.posts(launch.id).some((p) => p.channel === c) && !registry.cursor(failureKey(launch, c));
  });
  if (pending.length > 0) return { state: 'partial', launch: registry.get(launch.id)!, posted, problems };
  return { state: 'published', launch: registry.setStatus(launch.id, 'published', launch.detail), posted, problems };
}
