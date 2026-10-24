import type { Brand, Channel, ContentPack, LaunchConfig, PublishMode } from '@shipcast/schema';
import type { Launch } from './registry.ts';

/** A file of the drafts pull request, as a path in the launches repo and its text. */
export interface DraftFile {
  path: string;
  content: string;
}

/** A YAML scalar that needs no escaping thought: JSON strings are valid double-quoted YAML. */
const q = (value: string): string => JSON.stringify(value);

/** `yeyo11/claudio` → `claudio` */
export function projectSlug(repo: string): string {
  return repo.split('/').at(-1)!.toLowerCase();
}

/** Where a launch's pieces live in the launches repo: `launches/<project>/<ref>/`. */
export function launchDir(launch: Launch): string {
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
 * Turns a content pack into the files of the drafts pull request: the articles where the blog reads
 * them, a readable draft per channel for review, and the pack itself for the engine to publish from
 * once the pull request is merged. Edits made in the pull request are what gets published.
 */
export function renderDrafts(pack: ContentPack, launch: Launch, config: LaunchConfig, brand: Brand, date: Date): DraftFile[] {
  const files: DraftFile[] = [];
  const dir = launchDir(launch);
  const mode = (c: Channel) => config.publishing[c];
  const articleUrl = (lang: string) => `${brand.site}/${lang}/${pack.article?.slug ?? ''}/`;

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
        `translationKey: ${q(pack.article.slug)}`,
        `repo: ${q(pack.project.repo)}`,
        ...(pack.project.version ? [`version: ${q(pack.project.version)}`] : []),
        `tags: [${pack.article.tags.map(q).join(', ')}]`,
        '---',
      ].join('\n');
      files.push({ path: `src/content/posts/${lang}/${pack.article.slug}.md`, content: `${frontMatter}\n\n${version.markdown.trim()}\n` });
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
  if (pack.bluesky && mode('bluesky') !== 'off') {
    files.push({ path: `${dir}/bluesky.md`, content: draft('Bluesky', mode('bluesky'), pack.bluesky.text) });
  }
  if (pack.mastodon && mode('mastodon') !== 'off') {
    files.push({ path: `${dir}/mastodon.md`, content: draft('Mastodon', mode('mastodon'), pack.mastodon.text) });
  }
  if (pack.instagram && mode('instagram') !== 'off') {
    const media = pack.instagram.media === 'demo-video' ? 'the demo, as a Reel' : 'the launch image';
    files.push({
      path: `${dir}/instagram.md`,
      content: draft('Instagram', mode('instagram'), `Media: ${media}.\n\n${pack.instagram.caption}`),
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
