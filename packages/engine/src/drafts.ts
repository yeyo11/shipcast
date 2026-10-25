import { articleUrl as urlOf, hasDemo, type Brand, type Channel, type ContentPack, type LaunchConfig, type PublishMode } from '@shipcast/schema';
import { carouselPieces } from './launch-assets.ts';
import { issueDraftBody } from './newsletter.ts';
import type { Launch } from './registry.ts';

/** A file of the drafts pull request, as a path in the launches repo and its text. */
export type DraftFile = { path: string; content: string } | { path: string; bytes: Uint8Array };

/** A YAML scalar that needs no escaping thought: JSON strings are valid double-quoted YAML. */
const q = (value: string): string => JSON.stringify(value);

/**
 * The comment that goes under the Instagram post: the article's address, which a caption cannot link,
 * and a question that invites an answer. Links in comments are not clickable either, hence the bio.
 */
export function instagramComment(pack: ContentPack, brand: Brand): string {
  const url = (urlOf(pack, brand.site, 'en') ?? urlOf(pack, brand.site, 'es') ?? brand.site).replace(/^https:\/\//, '');
  return `Full write-up: ${url} (link in bio). What would you use it for?`;
}

/** Splits an Instagram draft as edited: the caption after the `---` line, the comment on its line. */
export function parseInstagramDraft(body: string): { caption: string; comment: string | undefined } {
  const [head, ...rest] = body.split(/^---$/m);
  const caption = rest.length > 0 ? rest.join('---').trim() : body.trim();
  return { caption, comment: /^Comment: (.+)$/m.exec(head ?? '')?.[1]?.trim() };
}

/** `yeyo11/claudio` → `claudio` */
export function projectSlug(repo: string): string {
  return repo.split('/').at(-1)!.toLowerCase();
}

/** An article written in the app, not a release: its ref is `article:<slug>` and its repo the launches repo */
export function isArticle(launch: Pick<Launch, 'ref'>): boolean {
  return launch.ref.startsWith('article:');
}

/** Where a launch's pieces live in the launches repo: `launches/<project>/<ref>/`, or `articles/<slug>/` for an article. */
export function launchDir(launch: Launch): string {
  if (isArticle(launch)) return `articles/${launch.ref.slice('article:'.length).replace(/[^a-z0-9-]/g, '-')}`;
  return `launches/${projectSlug(launch.repo)}/${launch.ref.replace(/[^A-Za-z0-9._-]/g, '_')}`;
}

function modeLine(mode: PublishMode): string {
  return mode === 'manual'
    ? '> **Manual:** Shipcast never posts this. Copy it and post it yourself.'
    : mode === 'auto'
      ? '> **Auto:** published without waiting for this pull request.'
      : '> **Approval:** published when this pull request is merged. Edit it here if it needs changes.';
}

function draft(title: string, mode: PublishMode, body: string): string {
  return `# ${title}\n\n${modeLine(mode)}\n\n${body.trim()}\n`;
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
): DraftFile[] {
  const files: DraftFile[] = [];
  const dir = launchDir(launch);
  const mode = (c: Channel) => config.publishing[c];
  const articleUrl = (lang: 'en' | 'es') => urlOf(pack, brand.site, lang) ?? brand.site;
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
        ...(isArticle(launch) ? [] : [`repo: ${q(pack.project.repo)}`]),
        ...(pack.project.version ? [`version: ${q(pack.project.version)}`] : []),
        `tags: [${pack.article.tags.map(q).join(', ')}]`,
        ...(image ? [`image: ${q(image)}`] : []),
        '---',
      ].join('\n');
      files.push({ path: `src/content/posts/${lang}/${version.slug}.md`, content: `${frontMatter}\n\n${version.markdown.trim()}\n` });
    }
  }

  if (pack.devto && mode('devto') !== 'off') {
    files.push({
      path: `${dir}/devto.md`,
      content: draft(
        'dev.to',
        mode('devto'),
        `Republishes the English article with its canonical URL set to ${articleUrl('en')}.\n\nTags: ${pack.devto.tags.map((t) => `\`${t}\``).join(', ')}`,
      ),
    });
  }
  if (pack.hashnode && mode('hashnode') !== 'off') {
    files.push({
      path: `${dir}/hashnode.md`,
      content: draft(
        'Hashnode',
        mode('hashnode'),
        `Republishes the English article with its original URL set to ${articleUrl('en')}.\n\nTags: ${pack.hashnode.tags.map((t) => `\`${t}\``).join(', ')}`,
      ),
    });
  }
  if (pack.telegram && mode('telegram') !== 'off') {
    files.push({ path: `${dir}/telegram.md`, content: draft('Telegram', mode('telegram'), pack.telegram.text) });
  }
  if (pack.discord && mode('discord') !== 'off') {
    files.push({ path: `${dir}/discord.md`, content: draft('Discord', mode('discord'), pack.discord.text) });
  }
  if (pack.hackerNews && mode('hackerNews') !== 'off') {
    files.push({
      path: `${dir}/show-hn.md`,
      content: draft(
        'Show HN',
        mode('hackerNews'),
        `Title: ${pack.hackerNews.title}\n\nURL to submit: ${pack.project.repo}\n\nFirst comment, to post right after submitting:\n\n${pack.hackerNews.firstComment}`,
      ),
    });
  }
  if (pack.productHunt && mode('productHunt') !== 'off') {
    const ph = pack.productHunt;
    // The images the launch builds, which the owner uploads to the gallery by hand
    const gallery = [
      'og.png',
      ...(pack.instagram && mode('instagram') !== 'off' ? carouselPieces(pack, config).filter((p) => p.kind === 'image').map((p) => p.file) : []),
    ];
    files.push({
      path: `${dir}/product-hunt.md`,
      content: draft(
        'Product Hunt',
        mode('productHunt'),
        [
          `Tagline: ${ph.tagline}`,
          '',
          `Description: ${ph.description}`,
          '',
          `Website: ${pack.project.repo}`,
          '',
          "Maker's first comment:",
          '',
          ph.firstComment,
          '',
          `Gallery, from \`public/${dir}/\`:`,
          '',
          ...gallery.map((f) => `- ${f}`),
        ].join('\n'),
      ),
    });
  }
  if (pack.bluesky && mode('bluesky') !== 'off') {
    files.push({ path: `${dir}/bluesky.md`, content: draft('Bluesky', mode('bluesky'), pack.bluesky.text) });
  }
  if (pack.mastodon && mode('mastodon') !== 'off') {
    files.push({ path: `${dir}/mastodon.md`, content: draft('Mastodon', mode('mastodon'), pack.mastodon.text) });
  }
  if (pack.instagram && mode('instagram') !== 'off') {
    const ig = pack.instagram;
    const slides = [
      `Cover: ${pack.article?.en?.title ?? pack.project.name}. ${ig.summary}`,
      ...(hasDemo(config) ? ['The demo, as a video'] : []),
      ...ig.slides.map((s) => `${s.title}: ${s.text}`),
      'Closing: the full write-up is in my bio',
    ];
    files.push({
      path: `${dir}/instagram.md`,
      content: draft(
        'Instagram',
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
    });
  }
  if (pack.reddit && mode('reddit') !== 'off') {
    pack.reddit.forEach((post, i) => {
      const name = post.subreddit ? `r/${post.subreddit}` : 'a subreddit to choose';
      files.push({
        path: `${dir}/reddit-${post.subreddit?.toLowerCase() ?? i + 1}.md`,
        content: draft(`Reddit, ${name}`, mode('reddit'), `**${post.title}**\n\n${post.body}`),
      });
    });
  }
  if (pack.newsletter && mode('newsletter') !== 'off') {
    for (const lang of ['en', 'es'] as const) {
      const issue = pack.newsletter[lang];
      if (issue) {
        files.push({ path: `${dir}/newsletter-${lang}.md`, content: draft(`Newsletter (${lang})`, mode('newsletter'), issueDraftBody(issue)) });
      }
    }
  }
  if (pack.releaseNotes) {
    files.push({ path: `${dir}/release-notes.md`, content: `# Release notes\n\n${pack.releaseNotes.trim()}\n` });
  }

  files.push({ path: `${dir}/pack.json`, content: `${JSON.stringify(pack, null, 2)}\n` });
  return files;
}

/** The pull request's description: what the code analysis found, and what merging does. */
export function pullRequestBody(pack: ContentPack, launch: Launch, config: LaunchConfig): string {
  const list = (items: string[]) => (items.length > 0 ? items.map((i) => `- ${i}`).join('\n') : '- none');
  const channels = (Object.keys(config.publishing) as Channel[])
    .filter((c) => config.publishing[c] !== 'off')
    .map((c) => `- **${c}**: ${config.publishing[c]}`)
    .join('\n');
  return [
    `Launch of [${launch.repo}](https://github.com/${launch.repo}) at \`${launch.ref}\` (${launch.kind} pack), drafted by Shipcast from the code.`,
    '',
    '**Merging publishes** the article on the blog and every `approval` channel; `manual` drafts are for you to post.',
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
  ].join('\n');
}
