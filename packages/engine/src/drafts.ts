import { articleLink, CHANNEL_DEFINITIONS, discussionDraft, draftFile, hasDemo, type Brand, type Channel, type ChannelDefinition, type ContentPack, type LaunchConfig, type PublishMode } from '@shipcast/schema';
import type { GitHubSource } from './github.ts';
import { issueDraftBody } from './newsletter.ts';

// The draft formats are the channels' (packages/schema/src/channels/text.ts); kept importable from here
export { discussionDraft, parseDiscussionDraft, parseInstagramDraft } from '@shipcast/schema';
import type { Launch } from './repositories/index.ts';

/** A file of the drafts pull request, as a path in the launches repo and its text. */
export type DraftFile = { path: string; content: string } | { path: string; bytes: Uint8Array };

/** A YAML scalar that needs no escaping thought: JSON strings are valid double-quoted YAML. */
const q = (value: string): string => JSON.stringify(value);

/**
 * The comment that goes under the Instagram post: the article's address, which a caption cannot link,
 * and a question that invites an answer. Links in comments are not clickable either, hence the bio.
 */
export function instagramComment(pack: ContentPack, brand: Brand): string {
  const url = articleLink(pack, brand.site, 'en', 'es').replace(/^https:\/\//, '');
  return `Full write-up: ${url} (link in bio). What would you use it for?`;
}

/** Each subreddit's post is a draft of its own, edited like a discussion: a title line, then the body */
export const redditDraftFile = (subreddit: string): string => draftFile('reddit', subreddit).name;

/** `yeyo11/claudio` → `claudio` */
export function projectSlug(repo: string): string {
  return repo.split('/').at(-1)!.toLowerCase();
}

/** An article written in the app, not a release: its ref is `article:<slug>` and its repo the launches repo */
export function isArticle(launch: Pick<Launch, 'ref'>): boolean {
  return launch.ref.startsWith('article:');
}

/**
 * The name a piece may show as its project's, or nothing for an article: an article's "project name"
 * is its title in the language the owner wrote it in, which put Spanish into English pieces (the REA
 * article's Mastodon alt text and its Instagram cover, 2026-10-28). A release's name is the repo's own.
 */
export function projectLabel(pack: Pick<ContentPack, 'project'>, launch: Pick<Launch, 'ref'>): string | undefined {
  return isArticle(launch) ? undefined : pack.project.name;
}

/** Where a launch's pieces live in the launches repo: `launches/<project>/<ref>/`, or `articles/<slug>/` for an article. */
export function launchDir(launch: Launch): string {
  if (isArticle(launch)) return `articles/${launch.ref.slice('article:'.length).replace(/[^a-z0-9-]/g, '-')}`;
  return `launches/${projectSlug(launch.repo)}/${launch.ref.replace(/[^A-Za-z0-9._-]/g, '_')}`;
}

function modeLine(mode: PublishMode): string {
  return mode === 'auto'
    ? '> **Auto:** published without waiting for this pull request.'
    : '> **Approval:** published when this pull request is merged. Edit it here if it needs changes.';
}

function draft(title: string, mode: PublishMode, body: string): string {
  return `# ${title}\n\n${modeLine(mode)}\n\n${body.trim()}\n`;
}

/** A channel's draft file in the launch's folder, named and headed as its definition says */
function channelDraft(dir: string, channel: Channel, mode: PublishMode, body: string, part = ''): DraftFile {
  const file = draftFile(channel, part);
  return { path: `${dir}/${file.name}`, content: draft(file.title, mode, body) };
}

/**
 * Drafts published without a pull request say so: their mode line would otherwise speak of a merge
 * that never happens. Only the line changes, so publishing reads them as it reads any other.
 */
export function asPublishedDirectly(files: DraftFile[]): DraftFile[] {
  const pending = /^> \*\*(Approval|Auto):\*\* .*$/m;
  return files.map((f) =>
    'content' in f && f.path.endsWith('.md') && pending.test(f.content)
      ? { ...f, content: f.content.replace(pending, '> **Published directly:** sent out without a pull request; edit it on the channel itself.') }
      : f,
  );
}

/**
 * An article written again over one already on the blog (a later launch whose slug is the same, or the
 * same launch drafted twice) keeps the day it was first published and says when it changed:
 * `pubDate` from the file on the launches repo's main branch, `updatedDate` today. New articles are
 * left as rendered.
 */
export async function keepPubDates(files: readonly DraftFile[], github: Pick<GitHubSource, 'fileAt'>, launchesRepo: string, date: Date): Promise<DraftFile[]> {
  const today = date.toISOString().slice(0, 10);
  return Promise.all(
    files.map(async (file) => {
      if (!('content' in file) || !/^src\/content\/posts\/(en|es)\/[^/]+\.md$/.test(file.path)) return file;
      const existing = await github.fileAt(launchesRepo, file.path, 'HEAD');
      const first = existing && /^pubDate: (\S+)$/m.exec(existing)?.[1];
      if (!first || first === today) return file;
      const content = file.content.replace(/^pubDate: \S+$/m, `pubDate: ${first}\nupdatedDate: ${today}`);
      return { ...file, content };
    }),
  );
}

/**
 * Turns a content pack into the files of the drafts pull request: the articles where the blog reads
 * them, a readable draft per channel for review, and the pack itself for the engine to publish from
 * once the pull request is merged. Edits made in the pull request are what gets published.
 */
export function renderDrafts(
  pack: ContentPack,
  launch: Launch,
  config: LaunchConfig,
  brand: Brand,
  date: Date,
  /** The launch image's site path, for the article's front matter */
  image?: string,
  /** Site paths of the deployed project's desktop screenshots, the first shown inside the article */
  screenshots: readonly string[] = [],
): DraftFile[] {
  const files: DraftFile[] = [];
  const dir = launchDir(launch);
  const mode = (c: Channel) => config.publishing[c];
  // Each language has its own slug; the key the blog pairs translations by is the first of them
  const translationKey = pack.article?.en?.slug ?? pack.article?.es?.slug ?? '';

  if (pack.article && mode('blog') !== 'off') {
    for (const lang of ['en', 'es'] as const) {
      const version = pack.article[lang];
      if (!version) continue;
      const frontMatter = [
        '---',
        `title: ${q(version.title)}`,
        `description: ${q(version.description)}`,
        `pubDate: ${date.toISOString().slice(0, 10)}`,
        `lang: ${lang}`,
        `translationKey: ${q(translationKey)}`,
        // An article written in the app belongs to no project, so the blog shows no repo for it
        ...(isArticle(launch) || !pack.project.repo ? [] : [`repo: ${q(pack.project.repo)}`]),
        ...(pack.project.version ? [`version: ${q(pack.project.version)}`] : []),
        `tags: [${pack.article.tags.map(q).join(', ')}]`,
        ...(image ? [`image: ${q(image)}`, `imageAlt: ${q(version.imageAlt ?? [projectLabel(pack, launch), version.title].filter(Boolean).join(': '))}`] : []),
        '---',
      ].join('\n');
      files.push({ path: `src/content/posts/${lang}/${version.slug}.md`, content: `${frontMatter}\n\n${withScreenshot(version.markdown.trim(), screenshots[0], projectLabel(pack, launch) ?? version.title, lang)}\n` });
    }
  }

  if (pack.devto && mode('devto') !== 'off') {
    files.push(
      channelDraft(dir, 'devto', mode('devto'), `Republishes the English article with its canonical URL set to ${articleLink(pack, brand.site, 'en')}.\n\nTags: ${pack.devto.tags.map((t) => `\`${t}\``).join(', ')}`),
    );
  }
  if (pack.hashnode && mode('hashnode') !== 'off') {
    files.push(
      channelDraft(dir, 'hashnode', mode('hashnode'), `Republishes the English article with its original URL set to ${articleLink(pack, brand.site, 'en')}.\n\nTags: ${pack.hashnode.tags.map((t) => `\`${t}\``).join(', ')}`),
    );
  }
  if (pack.telegram && mode('telegram') !== 'off') {
    files.push(channelDraft(dir, 'telegram', mode('telegram'), pack.telegram.text));
  }
  if (pack.discord && mode('discord') !== 'off') {
    files.push(channelDraft(dir, 'discord', mode('discord'), pack.discord.text));
  }
  if (pack.githubDiscussions && mode('githubDiscussions') !== 'off') {
    files.push(channelDraft(dir, 'githubDiscussions', mode('githubDiscussions'), discussionDraft(pack.githubDiscussions)));
  }
  if (pack.threads && mode('threads') !== 'off') {
    files.push(channelDraft(dir, 'threads', mode('threads'), pack.threads.text));
  }
  if (pack.linkedin && mode('linkedin') !== 'off') {
    files.push(channelDraft(dir, 'linkedin', mode('linkedin'), pack.linkedin.text));
  }
  if (pack.bluesky && mode('bluesky') !== 'off') {
    files.push(channelDraft(dir, 'bluesky', mode('bluesky'), pack.bluesky.text));
  }
  if (pack.mastodon && mode('mastodon') !== 'off') {
    files.push(channelDraft(dir, 'mastodon', mode('mastodon'), pack.mastodon.text));
  }
  if (pack.instagram && mode('instagram') !== 'off') {
    const ig = pack.instagram;
    const slides = [
      `Cover: ${pack.article?.en?.title ?? pack.project.name}. ${ig.summary}`,
      ...(hasDemo(config) ? ['The demo, as a video'] : []),
      ...ig.slides.map((s) => `${s.title}: ${s.text}`),
      'Closing: the full write-up is in my bio',
    ];
    files.push(
      channelDraft(
        dir,
        'instagram',
        mode('instagram'),
        [
          `Carousel, from the images in \`public/${dir}/\` (their texts are drawn into them; only the caption and the comment below can be edited here):`,
          '',
          ...slides.map((s, i) => `${i + 1}. ${s}`),
          '',
          'Story: the cover with "Link in bio" (the API cannot add a link sticker).',
          '',
          `Comment: ${instagramComment(pack, brand)}`,
          '',
          '---',
          '',
          ig.caption,
        ].join('\n'),
      ),
    );
  }
  if (pack.reddit && mode('reddit') !== 'off') {
    for (const post of pack.reddit) {
      files.push(channelDraft(dir, 'reddit', mode('reddit'), discussionDraft(post), post.subreddit));
    }
  }
  if (pack.newsletter && mode('newsletter') !== 'off') {
    for (const lang of ['en', 'es'] as const) {
      const issue = pack.newsletter[lang];
      if (issue) {
        files.push(channelDraft(dir, 'newsletter', mode('newsletter'), issueDraftBody(issue), lang));
      }
    }
  }
  // The channels that lay out their own drafts (their definition's `draft.write`), with no branch above
  for (const definition of CHANNEL_DEFINITIONS as readonly ChannelDefinition<Channel>[]) {
    // A definition's `write` takes its own piece, which the pack holds under its key
    const write = definition.draft?.write as ((piece: unknown) => Array<{ part: string; body: string }>) | undefined;
    const piece: unknown = (pack as Record<string, unknown>)[definition.pack.key];
    if (!write || piece === undefined || mode(definition.id) === 'off') continue;
    for (const { part, body } of write(piece)) files.push(channelDraft(dir, definition.id, mode(definition.id), body, part));
  }
  if (pack.releaseNotes) {
    files.push({ path: `${dir}/release-notes.md`, content: `# Release notes\n\n${pack.releaseNotes.trim()}\n` });
  }

  files.push({ path: `${dir}/pack.json`, content: `${JSON.stringify(pack, null, 2)}\n` });
  return files;
}

/** The pull request's description: what the code analysis found, and what merging does. */
export function pullRequestBody(pack: ContentPack, launch: Launch, config: LaunchConfig): string {
  return [`Launch of [${launch.repo}](https://github.com/${launch.repo}) at \`${launch.ref}\` (${launch.kind} pack), drafted by Shipcast from the code.`, '', ...reviewSections(pack, config)].join('\n');
}

/** What a drafts pull request says below its first line: how merging works, the analysis and the channels */
export function reviewSections(pack: ContentPack, config: LaunchConfig): string[] {
  const list = (items: string[]) => (items.length > 0 ? items.map((i) => `- ${i}`).join('\n') : '- none');
  const channels = (Object.keys(config.publishing) as Channel[])
    .filter((c) => config.publishing[c] !== 'off')
    .map((c) => `- **${c}**: ${config.publishing[c]}`)
    .join('\n');
  return [
    '**Merging publishes** the article on the blog and every `approval` channel.',
    'Edit any file in this pull request first: what is merged is what gets published.',
    '',
    '### What the code shows',
    '',
    pack.analysis.summary,
    '',
    '**Implemented**',
    list(pack.analysis.implemented),
    '',
    '**Planned, not presented as working**',
    list(pack.analysis.planned),
    '',
    '**Claimed by the docs but not backed by the code**',
    list(pack.analysis.documentedOnly),
    '',
    '**Limitations**',
    list(pack.analysis.limitations),
    '',
    '### Channels',
    '',
    channels,
  ];
}

/**
 * Puts the deployed project's first screenshot after the article's opening paragraph, where a reader
 * (and an image search) meets it with the paragraph that says what the project is.
 */
export function withScreenshot(markdown: string, screenshot: string | undefined, project: string, lang: 'en' | 'es'): string {
  if (!screenshot || markdown.includes(screenshot)) return markdown;
  const alt = lang === 'es' ? `${project}, captura de pantalla` : `${project}, screenshot`;
  const end = markdown.indexOf('\n\n');
  const image = `![${alt}](${screenshot})`;
  return end === -1 ? `${markdown}\n\n${image}` : `${markdown.slice(0, end)}\n\n${image}${markdown.slice(end)}`;
}

/** The site paths of the desktop screenshots among a launch's media files, the home page first */
export function screenshotPaths(files: readonly DraftFile[]): string[] {
  return files
    .map((f) => f.path)
    .filter((p) => /^public\/.+\/screenshots\/[a-z0-9-]+-desktop\.png$/.test(p))
    .map((p) => p.slice('public'.length))
    .sort((a, b) => Number(!a.includes('/screenshots/home-')) - Number(!b.includes('/screenshots/home-')));
}
